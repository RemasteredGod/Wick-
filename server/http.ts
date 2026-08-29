/**
 * Node request and response plumbing, kept out of the handlers.
 *
 * Vercel's functions in `api/` are invoked with Node's `(req, res)` pair rather
 * than a web-standard `Request` returning a `Response`. A handler written to
 * return a `Response` loads fine, runs fine, and produces a correct object that
 * Vercel then discards — the response is never ended, and the invocation fails
 * with a 500 that says nothing about the cause. So the contract is written out
 * explicitly here rather than assumed anywhere.
 *
 * This lives outside `api/` on purpose: every file in that directory becomes a
 * route, and a shared helper is not one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage;
export type Res = ServerResponse;

/** Long enough for the issued 43-character token, while bounding header work. */
const MAX_BEARER_TOKEN_LENGTH = 128;
const MAX_AUTHORIZATION_LENGTH = 'Bearer '.length + MAX_BEARER_TOKEN_LENGTH;
const MAX_CONTENT_TYPE_LENGTH = 128;
const MAX_CONTENT_LENGTH_LENGTH = 20;

/** Headers every page sends. The pages are self-contained, so this can be strict. */
const SECURITY_HEADERS: Record<string, string> = {
  // No scripts, no external assets, no fonts. Saying so costs nothing and
  // closes the injection surface outright.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** Send an HTML page and end the response. A HEAD response carries its GET headers only. */
export function sendHtml(
  res: Res,
  status: number,
  html: string,
  cacheControl: string,
  headOnly = false,
): void {
  const encoded = Buffer.from(html, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(encoded.length));
  res.setHeader('Cache-Control', cacheControl);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.end(headOnly ? undefined : encoded);
}

/**
 * Send a JSON body and end the response.
 *
 * No security headers: those exist for the HTML pages, where a CSP is worth
 * stating, and a JSON body rendered by a browser is not a document. `no-store`
 * is the default because every JSON route here is either authenticated or mints
 * a credential, and a cached copy of either is a copy handed to the next caller.
 */
export function sendJson(
  res: Res,
  status: number,
  body: unknown,
  cacheControl = 'no-store',
  headOnly = false,
): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(encoded.length));
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(headOnly ? undefined : encoded);
}

/**
 * The bearer token on a request, or `null`.
 *
 * Strict about the scheme, shape, and size. The service issues 43-character
 * base64url tokens; allowing modest headroom preserves token-format changes
 * without accepting an unbounded attacker-controlled header.
 */
export function bearerToken(req: Req): string | null {
  const value = header(req, 'authorization', MAX_AUTHORIZATION_LENGTH);
  if (value === null) return null;

  const match = /^Bearer ([!-~]{1,128})$/.exec(value);
  return match?.[1] ?? null;
}

/** Whether the request declares the JSON media type, with optional parameters. */
export function hasJsonContentType(req: Req): boolean {
  const value = header(req, 'content-type', MAX_CONTENT_TYPE_LENGTH);
  if (value === null) return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

/** Send a short plain-text body and end the response. */
export function sendText(res: Res, status: number, body: string, headOnly = false): void {
  const encoded = Buffer.from(body, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(encoded.length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(headOnly ? undefined : encoded);
}

/**
 * One query parameter.
 *
 * `req.url` is a path with a query and no origin, which `URL` will not parse on
 * its own — hence the throwaway base. Nothing reads the host from it.
 */
export function queryParam(req: Req, name: string): string | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get(name);
  } catch {
    return null;
  }
}

/**
 * One request header, as a single bounded string.
 *
 * Node gives `string | string[] | undefined`. A repeated header is not a header
 * Wick understands, so it is read as absent rather than joined into something
 * that might accidentally compare equal to a secret.
 */
export function header(req: Req, name: string, maxLength = Number.MAX_SAFE_INTEGER): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

export type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; error: 'malformed' | 'too-large' };

/**
 * Read and parse a bounded JSON body.
 *
 * The streamed byte count is authoritative. `Content-Length` is only an early
 * rejection hint because clients can omit it or lie in either direction. Even
 * after crossing the cap the stream is drained, so a keep-alive connection is
 * not left with unread request bytes and no oversized chunks are retained.
 */
export async function readJson(req: Req, limitBytes: number): Promise<JsonReadResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = declaredTooLarge(req, limitBytes);

  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > limitBytes) tooLarge = true;
      if (!tooLarge) chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: 'malformed' };
  }

  if (tooLarge) return { ok: false, error: 'too-large' };
  if (chunks.length === 0) return { ok: false, error: 'malformed' };

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

function declaredTooLarge(req: Req, limitBytes: number): boolean {
  const value = header(req, 'content-length', MAX_CONTENT_LENGTH_LENGTH);
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return false;

  const length = Number(value);
  return !Number.isSafeInteger(length) || length > limitBytes;
}

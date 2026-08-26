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

/** Headers every page sends. The pages are self-contained, so this can be strict. */
const SECURITY_HEADERS: Record<string, string> = {
  // No scripts, no external assets, no fonts. Saying so costs nothing and
  // closes the injection surface outright.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** Send an HTML page and end the response. */
export function sendHtml(
  res: Res,
  status: number,
  html: string,
  cacheControl: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.end(html);
}

/** Send a short plain-text body and end the response. */
export function sendText(res: Res, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
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
 * One request header, as a single string.
 *
 * Node gives `string | string[] | undefined`. A repeated header is not a header
 * Wick understands, so it is read as absent rather than joined into something
 * that might accidentally compare equal to a secret.
 */
export function header(req: Req, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

/**
 * The request body, parsed as JSON.
 *
 * Returns `null` for a body that is absent, too large, or unparseable — all of
 * which the caller treats the same way. The cap exists because this is fed
 * straight from the network: without it, one large POST holds a function open
 * until it times out.
 */
export async function readJson(req: Req, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > limitBytes) return null;
      chunks.push(buffer);
    }
  } catch {
    return null;
  }

  if (chunks.length === 0) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

import { Readable } from 'node:stream';
import type { Req, Res } from '../../server/http';

interface RequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  chunks?: string[];
}

export function request(options: RequestOptions = {}): Req {
  const source = options.chunks ?? (options.body === undefined ? [] : [options.body]);
  const stream = Readable.from(source.map((chunk) => Buffer.from(chunk, 'utf8')));
  Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: normaliseHeaders(options.headers ?? {}),
  });
  return stream as unknown as Req;
}

export interface ResponseCapture {
  readonly res: Res;
  readonly headers: Record<string, string>;
  readonly status: () => number;
  readonly body: () => string;
  readonly ended: () => boolean;
}

export function response(): ResponseCapture {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let didEnd = false;

  const target = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf8'));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      didEnd = true;
      return this;
    },
  };

  return {
    res: target as unknown as Res,
    headers,
    status: () => target.statusCode,
    body: () => Buffer.concat(chunks).toString('utf8'),
    ended: () => didEnd,
  };
}

export function jsonBody(capture: ResponseCapture): unknown {
  return JSON.parse(capture.body()) as unknown;
}

function normaliseHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

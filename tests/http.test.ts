import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  hasJsonContentType,
  readJson,
  sendHtml,
  sendJson,
} from '../server/http';
import { request, response } from './helpers/http';

describe('HTTP helpers', () => {
  it('reads valid JSON within the byte cap', async () => {
    await expect(readJson(request({ body: '{"ok":true}' }), 32)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('enforces streamed bytes when Content-Length lies low', async () => {
    const req = request({
      headers: { 'content-length': '2' },
      chunks: ['{"value":"', 'far too long', '"}'],
    });
    await expect(readJson(req, 16)).resolves.toEqual({ ok: false, error: 'too-large' });
  });

  it('rejects an over-limit declared length even when the delivered body is small', async () => {
    const req = request({ headers: { 'content-length': '999' }, body: '{}' });
    await expect(readJson(req, 16)).resolves.toEqual({ ok: false, error: 'too-large' });
  });

  it('counts UTF-8 bytes rather than JavaScript characters', async () => {
    await expect(readJson(request({ body: '"éé"' }), 5)).resolves.toEqual({
      ok: false,
      error: 'too-large',
    });
  });

  it('distinguishes malformed JSON from an oversized body', async () => {
    await expect(readJson(request({ body: '{' }), 16)).resolves.toEqual({
      ok: false,
      error: 'malformed',
    });
    await expect(readJson(request(), 16)).resolves.toEqual({
      ok: false,
      error: 'malformed',
    });
  });

  it('requires application/json while allowing bounded parameters', () => {
    expect(hasJsonContentType(request({ headers: { 'content-type': 'application/json' } }))).toBe(
      true,
    );
    expect(
      hasJsonContentType(
        request({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }),
      ),
    ).toBe(true);
    expect(hasJsonContentType(request({ headers: { 'content-type': 'text/json' } }))).toBe(false);
    expect(
      hasJsonContentType(request({ headers: { 'content-type': `application/json;${'x'.repeat(130)}` } })),
    ).toBe(false);
  });

  it('accepts issued-shape bearer values and rejects oversized or repeated headers', () => {
    expect(bearerToken(request({ headers: { authorization: 'Bearer token_123' } }))).toBe(
      'token_123',
    );
    expect(bearerToken(request({ headers: { authorization: `Bearer ${'a'.repeat(129)}` } }))).toBeNull();
    expect(
      bearerToken(request({ headers: { authorization: ['Bearer first', 'Bearer second'] } })),
    ).toBeNull();
  });

  it('sends GET-equivalent headers but no entity body for HEAD', () => {
    const html = response();
    sendHtml(html.res, 200, '<p>Hello</p>', 'no-store', true);
    expect(html.status()).toBe(200);
    expect(html.headers['content-length']).toBe(String(Buffer.byteLength('<p>Hello</p>')));
    expect(html.body()).toBe('');

    const json = response();
    sendJson(json.res, 405, { error: 'method-not-allowed' }, 'no-store', true);
    expect(Number(json.headers['content-length'])).toBeGreaterThan(0);
    expect(json.body()).toBe('');
  });
});

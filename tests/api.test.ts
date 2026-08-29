import { beforeEach, describe, expect, it, vi } from 'vitest';
import boardHandler from '../api/board';
import enrollHandler from '../api/enroll';
import landingHandler from '../api/landing';
import leaveHandler from '../api/leave';
import profileHandler from '../api/profile';
import submitHandler from '../api/submit';
import { createSupabaseStore } from '../server/supabase-store';
import { jsonBody, request, response, type ResponseCapture } from './helpers/http';

const backend = vi.hoisted(() => ({
  board: vi.fn(),
  stats: vi.fn(),
  enroll: vi.fn(),
  profile: vi.fn(),
  saveDaily: vi.fn(),
  forget: vi.fn(),
}));

vi.mock('../server/supabase-store', () => ({
  configFromEnv: vi.fn(() => ({ url: 'https://example.invalid', serviceKey: 'key' })),
  createSupabaseStore: vi.fn(() => backend),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-29T03:00:00Z'));
  vi.clearAllMocks();
  backend.board.mockResolvedValue([]);
  backend.stats.mockResolvedValue(null);
  backend.enroll.mockResolvedValue({ token: 'issued-token', name: 'quiet-fern', existing: false });
  backend.profile.mockResolvedValue({ name: 'quiet-fern' });
  backend.saveDaily.mockResolvedValue(undefined);
  backend.forget.mockResolvedValue(undefined);
});

function post(body: string, token: string | null = null, contentType = 'application/json') {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return request({ method: 'POST', headers, body });
}

async function invoke(
  handler: (req: ReturnType<typeof request>, res: ResponseCapture['res']) => void | Promise<void>,
  req: ReturnType<typeof request>,
): Promise<ResponseCapture> {
  const capture = response();
  await handler(req, capture.res);
  return capture;
}

describe('public page methods and caching', () => {
  it.each([
    ['landing', landingHandler],
    ['board', boardHandler],
    ['profile', profileHandler],
  ])('%s allows only GET and HEAD', async (_name, handler) => {
    const capture = await invoke(handler, request({ method: 'POST', url: '/u/quiet-fern' }));
    expect(capture.status()).toBe(405);
    expect(capture.headers.allow).toBe('GET, HEAD');
    expect(capture.headers['cache-control']).toBe('no-store');
  });

  it('serves bodyless HEAD responses without turning them into writes', async () => {
    const landing = await invoke(landingHandler, request({ method: 'HEAD' }));
    expect(landing.status()).toBe(200);
    expect(landing.body()).toBe('');
    expect(Number(landing.headers['content-length'])).toBeGreaterThan(0);

    const board = await invoke(boardHandler, request({ method: 'HEAD', url: '/board?p=month' }));
    expect(board.status()).toBe(200);
    expect(board.body()).toBe('');
    expect(backend.board).toHaveBeenCalledWith('month', '2026-08-29', 100);

    const profile = await invoke(profileHandler, request({ method: 'HEAD', url: '/u/quiet-fern' }));
    expect(profile.status()).toBe(404);
    expect(profile.body()).toBe('');
    expect(backend.saveDaily).not.toHaveBeenCalled();
    expect(backend.forget).not.toHaveBeenCalled();
  });

  it('caches boards for no more than sixty seconds and never advertises SWR', async () => {
    const capture = await invoke(boardHandler, request({ method: 'GET', url: '/board' }));
    expect(capture.status()).toBe(200);
    expect(capture.headers['cache-control']).toBe('public, s-maxage=60');
    expect(capture.headers['cache-control']).not.toContain('stale-while-revalidate');
  });

  it('does not cache profile hits, misses, or external failures', async () => {
    const missing = await invoke(profileHandler, request({ method: 'GET', url: '/u/quiet-fern' }));
    expect(missing.status()).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');

    backend.stats.mockRejectedValueOnce(new Error('database detail must not escape'));
    const failed = await invoke(profileHandler, request({ method: 'GET', url: '/u/quiet-fern' }));
    expect(failed.status()).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(failed.body()).not.toContain('database detail');
  });
});

describe('mutation route envelopes', () => {
  it.each([
    ['enroll', enrollHandler],
    ['submit', submitHandler],
    ['leave', leaveHandler],
  ])('%s is POST-only with an Allow header and a bodyless HEAD rejection', async (_name, handler) => {
    const get = await invoke(handler, request({ method: 'GET' }));
    expect(get.status()).toBe(405);
    expect(get.headers.allow).toBe('POST');

    const head = await invoke(handler, request({ method: 'HEAD' }));
    expect(head.status()).toBe(405);
    expect(head.headers.allow).toBe('POST');
    expect(head.body()).toBe('');
  });

  it.each([
    ['enroll', enrollHandler, post('{"email":"person@example.com"}', null, 'text/plain')],
    ['submit', submitHandler, post('{"day":"2026-08-29","messages":1}', 'token', 'text/plain')],
    ['leave', leaveHandler, post('{}', 'token', 'text/plain')],
  ])('%s requires application/json', async (_name, handler, req) => {
    const capture = await invoke(handler, req);
    expect(capture.status()).toBe(415);
    expect(jsonBody(capture)).toEqual({ error: 'unsupported-media-type' });
  });

  it('applies small route-specific body limits even when Content-Length lies', async () => {
    const enroll = await invoke(
      enrollHandler,
      request({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: `{"email":"${'a'.repeat(520)}"}`,
      }),
    );
    expect(enroll.status()).toBe(413);

    const submit = await invoke(
      submitHandler,
      request({
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          'content-length': '2',
        },
        body: `{"day":"2026-08-29","messages":1,"padding":"${'a'.repeat(100)}"}`,
      }),
    );
    expect(submit.status()).toBe(413);

    const leave = await invoke(
      leaveHandler,
      request({
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          'content-length': '2',
        },
        body: `{"padding":"${'a'.repeat(20)}"}`,
      }),
    );
    expect(leave.status()).toBe(413);
  });

  it('rejects malformed bodies generically without reflecting parser details', async () => {
    const capture = await invoke(enrollHandler, post('{'));
    expect(capture.status()).toBe(400);
    expect(jsonBody(capture)).toEqual({ error: 'bad-request' });
  });

  it.each([
    ['a missing email key', '{}'],
    ['an extra key', '{"email":"person@example.com","admin":true}'],
    [
      'a prototype-manipulation key',
      '{"email":"person@example.com","__proto__":{"email":"attacker@example.com"}}',
    ],
    ['an array', '["person@example.com"]'],
    ['a string scalar', '"person@example.com"'],
    ['a null scalar', 'null'],
  ])('enroll rejects %s before creating or calling the store', async (_case, body) => {
    const capture = await invoke(enrollHandler, post(body));
    expect(capture.status()).toBe(400);
    expect(jsonBody(capture)).toEqual({ error: 'bad-request' });
    expect(createSupabaseStore).not.toHaveBeenCalled();
    expect(backend.enroll).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing body', ''],
    ['an extra key', '{"all":true}'],
    ['a prototype-manipulation key', '{"__proto__":0}'],
    ['an empty array', '[]'],
    ['a string scalar', '""'],
    ['a null scalar', 'null'],
  ])('leave rejects %s before creating or calling the store', async (_case, body) => {
    const capture = await invoke(leaveHandler, post(body, 'token'));
    expect(capture.status()).toBe(400);
    expect(jsonBody(capture)).toEqual({ error: 'bad-request' });
    expect(createSupabaseStore).not.toHaveBeenCalled();
    expect(backend.forget).not.toHaveBeenCalled();
  });

  it('authenticates leave before checking content type or reading its body', async () => {
    const capture = await invoke(
      leaveHandler,
      request({
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-length': '999' },
        body: '{',
      }),
    );
    expect(capture.status()).toBe(401);
    expect(jsonBody(capture)).toEqual({ error: 'unauthorized' });
    expect(createSupabaseStore).not.toHaveBeenCalled();
    expect(backend.forget).not.toHaveBeenCalled();
  });

  it('bounds the bearer header before touching storage', async () => {
    const capture = await invoke(
      submitHandler,
      post('{"day":"2026-08-29","messages":1}', 'x'.repeat(129)),
    );
    expect(capture.status()).toBe(401);
    expect(backend.profile).not.toHaveBeenCalled();
  });
});

describe('mutation behavior', () => {
  it('stores exactly day and messages and accepts the full retention boundary', async () => {
    const capture = await invoke(
      submitHandler,
      post('{"day":"2026-05-31","messages":7,"accountId":"must-not-survive"}', 'token'),
    );
    expect(capture.status()).toBe(200);
    expect(backend.saveDaily).toHaveBeenCalledWith('token', {
      day: '2026-05-31',
      messages: 7,
    });
    expect(Object.keys(backend.saveDaily.mock.calls[0]?.[1] as object).sort()).toEqual([
      'day',
      'messages',
    ]);
  });

  it('rejects an older day without restoring the former short window', async () => {
    const tooOld = await invoke(
      submitHandler,
      post('{"day":"2026-05-30","messages":7}', 'token'),
    );
    expect(tooOld.status()).toBe(400);
    expect(jsonBody(tooOld)).toEqual({ error: 'bad-day' });
    expect(backend.saveDaily).not.toHaveBeenCalled();
  });

  it('accepts one day of timezone skew and rejects a distant future day', async () => {
    const skewed = await invoke(
      submitHandler,
      post('{"day":"2026-08-30","messages":1}', 'token'),
    );
    expect(skewed.status()).toBe(200);

    const future = await invoke(
      submitHandler,
      post('{"day":"2026-08-31","messages":1}', 'token'),
    );
    expect(future.status()).toBe(400);
    expect(jsonBody(future)).toEqual({ error: 'bad-day' });
  });

  it('leaves account-wide through the existing store contract', async () => {
    const capture = await invoke(leaveHandler, post('{}', 'token'));
    expect(capture.status()).toBe(200);
    expect(jsonBody(capture)).toEqual({ left: true });
    expect(backend.forget).toHaveBeenCalledWith('token');
  });

  it('returns only a generic external error', async () => {
    backend.enroll.mockRejectedValueOnce(new Error('service key and SQL detail'));
    const capture = await invoke(enrollHandler, post('{"email":"person@example.com"}'));
    expect(capture.status()).toBe(503);
    expect(jsonBody(capture)).toEqual({ error: 'unavailable' });
    expect(capture.body()).not.toContain('service key');
  });

  it('keeps leave store failures generic and retryable', async () => {
    backend.forget.mockRejectedValueOnce(new Error('service key and SQL detail'));
    const capture = await invoke(leaveHandler, post('{}', 'token'));
    expect(capture.status()).toBe(503);
    expect(jsonBody(capture)).toEqual({ error: 'unavailable' });
    expect(capture.body()).not.toContain('service key');
  });
});

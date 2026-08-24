/**
 * The Claude provider, against the shapes docs/protocol.md describes.
 *
 * Every fixture here is written from that document, not captured from live
 * traffic — see the UNVERIFIED banner at the top of it. What these tests
 * therefore prove is not "Wick reads claude.ai correctly"; it is "Wick degrades
 * rather than breaks when it does not", which is the property that has to hold
 * whether or not the document turns out to be right.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalKey,
  fetchUsageResult,
  isCompletionUrl,
  limitWindowsFromEvent,
  limitWindowsFromRefusal,
  parseSseChunk,
  resetUsagePathMemo,
  USAGE_PATH_CANDIDATES,
  windowFromLimitEntry,
} from '~/providers/claude';

/* ---- Fixtures ------------------------------------------------------------ */

/**
 * Right-pad a JSON document with spaces before its closing brace, the way
 * docs/protocol.md says claude.ai does. The point of the padding in these tests
 * is that changing `spaces` must change nothing at all.
 */
function padded(json: string, spaces: number): string {
  return `${json.slice(0, -1)}${' '.repeat(spaces)}}`;
}

const RESET_SECONDS = 1_787_000_000;

const MESSAGE_LIMIT_JSON = JSON.stringify({
  type: 'message_limit',
  message_limit: {
    overageStatus: 'none',
    representativeClaim: 'five_hour',
    windows: {
      '5h': { status: 'exceeded_limit', resets_at: RESET_SECONDS, utilization: 0.98 },
      '7d': { status: 'ok', resets_at: RESET_SECONDS + 86_400, utilization: 0.41 },
    },
  },
});

function record(json: string, event = 'completion'): string {
  return `event: ${event}\ndata: ${json}\n\n`;
}

/* ---- SSE framing --------------------------------------------------------- */

describe('parseSseChunk', () => {
  it('reads a record and leaves no tail behind', () => {
    const { events, leftover } = parseSseChunk(record('{"type":"completion","completion":"hi"}'));

    expect(leftover).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('completion');
    expect(events[0]?.data).toEqual({ type: 'completion', completion: 'hi' });
  });

  it('is unaffected by the space padding', () => {
    // The hazard is not that padding breaks JSON.parse — it does not. It is
    // that record lengths stop meaning anything, so any logic that counted
    // bytes would silently disagree with itself between two identical events.
    const bare = parseSseChunk(record(MESSAGE_LIMIT_JSON));
    const stuffed = parseSseChunk(record(padded(MESSAGE_LIMIT_JSON, 400)));

    expect(stuffed.events.map((e) => e.data)).toEqual(bare.events.map((e) => e.data));
    expect(stuffed.events.map((e) => e.name)).toEqual(bare.events.map((e) => e.name));
    expect(stuffed.leftover).toBe(bare.leftover);
    // The raw text differs by 400 characters and the reading does not.
    expect(stuffed.events[0]?.raw.length).toBeGreaterThan(bare.events[0]?.raw.length ?? 0);
  });

  it('holds a record split across two chunks until the rest arrives', () => {
    const whole = record(MESSAGE_LIMIT_JSON);
    // Split inside the JSON, which is where a network boundary usually lands.
    const cut = Math.floor(whole.length / 2);

    const first = parseSseChunk(whole.slice(0, cut));
    expect(first.events).toHaveLength(0);
    expect(first.leftover).toBe(whole.slice(0, cut));

    const second = parseSseChunk(first.leftover + whole.slice(cut));
    expect(second.events).toHaveLength(1);
    expect(second.leftover).toBe('');
    expect(limitWindowsFromEvent(second.events[0]?.data)).toHaveLength(2);
  });

  it('keeps the completed records from a chunk that ends mid-record', () => {
    const chunk = record('{"type":"completion","completion":"a"}') + 'event: completion\ndata: {"ty';
    const { events, leftover } = parseSseChunk(chunk);

    expect(events).toHaveLength(1);
    expect(leftover).toBe('event: completion\ndata: {"ty');
  });

  it('frames the same way whichever line ending arrives', () => {
    const unix = parseSseChunk(record(MESSAGE_LIMIT_JSON));
    const windows = parseSseChunk(record(MESSAGE_LIMIT_JSON).replaceAll('\n', '\r\n'));

    expect(windows.events).toEqual(unix.events);
  });

  it('ignores keep-alive comments and records with no data', () => {
    const { events } = parseSseChunk(`: ping\n\nevent: ping\n\n${record('{"type":"x"}')}`);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ type: 'x' });
  });

  it('joins continuation data lines', () => {
    const { events } = parseSseChunk('data: {"type":\ndata: "message_limit"}\n\n');

    expect(events[0]?.data).toEqual({ type: 'message_limit' });
  });

  it('hands back unparseable data as the string it was, rather than throwing', () => {
    const { events } = parseSseChunk('event: x\ndata: not json at all\n\n');

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('not json at all');
  });

  it.each(['', '\n', '\n\n\n', 'data:\n\n'])('survives %p', (chunk) => {
    expect(() => parseSseChunk(chunk)).not.toThrow();
  });
});

/* ---- The message_limit event --------------------------------------------- */

describe('limitWindowsFromEvent', () => {
  const windows = limitWindowsFromEvent(JSON.parse(MESSAGE_LIMIT_JSON) as unknown);
  const session = windows?.find((w) => w.key === '5h');

  it('scales the 0-1 utilization and the unix-seconds reset', () => {
    expect(session?.utilization).toBe(98);
    expect(session?.resetsAt).toBe(RESET_SECONDS * 1000);
  });

  it('carries a bound window through as exceeded even though it reads under 100%', () => {
    // docs/protocol.md: status wins over the number at the boundary. If this
    // ever reports 'ok' the panel says 98% next to a composer that will not
    // send, which is the single most visible way this extension can look broken.
    expect(session?.status).toBe('exceeded');
  });

  it('labels the windows it knows and passes through the ones it does not', () => {
    expect(session?.shortLabel).toBe('Session');
    const odd = limitWindowsFromEvent({
      type: 'message_limit',
      message_limit: { windows: { '3d_experimental': { status: 'ok' } } },
    });
    expect(odd?.[0]?.key).toBe('3d_experimental');
    expect(odd?.[0]?.label).toBe('3d_experimental');
  });

  it('reports no utilization rather than zero when the field is missing', () => {
    const windows = limitWindowsFromEvent({
      type: 'message_limit',
      message_limit: { windows: { '5h': { status: 'ok' } } },
    });

    expect(windows?.[0]?.utilization).toBeNull();
  });

  it.each([
    { type: 'completion', completion: 'hello' },
    { type: 'message_limit' },
    { type: 'message_limit', message_limit: { windows: null } },
    'a string',
    null,
    undefined,
  ])('returns null for %p', (event) => {
    expect(limitWindowsFromEvent(event)).toBeNull();
  });
});

/* ---- The usage endpoint's limits[] --------------------------------------- */

describe('windowFromLimitEntry', () => {
  it('reads the integer percent and ISO reset the usage endpoint sends', () => {
    const window = windowFromLimitEntry({
      kind: '5h',
      group: 'session',
      percent: 82,
      severity: 'ok',
      resets_at: '2026-08-27T09:00:00Z',
      scope: 'org',
      is_active: true,
    });

    expect(window).toEqual({
      key: '5h',
      label: 'Session · 5 hr',
      shortLabel: 'Session',
      utilization: 82,
      status: 'ok',
      resetsAt: Date.parse('2026-08-27T09:00:00Z'),
      active: true,
    });
  });

  it('falls back through the other identifying fields', () => {
    expect(windowFromLimitEntry({ group: '7d', percent: 5 })?.key).toBe('7d');
    expect(windowFromLimitEntry({ scope: '7d', percent: 5 })?.key).toBe('7d');
  });

  it('says unknown rather than ok when the severity is a word it has not seen', () => {
    expect(windowFromLimitEntry({ kind: '5h', severity: 'chartreuse' })?.status).toBe('unknown');
  });

  it('reports a missing percent as unknown, not as zero', () => {
    const window = windowFromLimitEntry({ kind: '5h', resets_at: 'soon' });

    expect(window?.utilization).toBeNull();
    expect(window?.resetsAt).toBeNull();
  });

  it.each([null, undefined, 42, {}, { kind: '' }, { kind: 5 }])(
    'returns null for the unkeyable entry %p',
    (entry) => {
      expect(windowFromLimitEntry(entry)).toBeNull();
    },
  );
});

describe('canonicalKey', () => {
  it('folds the spellings of one window onto one key', () => {
    // Daily rollups are keyed on this and are append-only. Two spellings of the
    // session window means two half-histories that can never be merged, and
    // claude.ai already uses two in a single payload ("5h" in `windows`,
    // "five_hour" in `representativeClaim`).
    expect(canonicalKey('five_hour')).toBe('5h');
    expect(canonicalKey('FIVE_HOUR')).toBe('5h');
    expect(canonicalKey('weekly')).toBe('7d');
    expect(canonicalKey('5h')).toBe('5h');
  });

  it('leaves a key it does not recognise exactly as it found it', () => {
    expect(canonicalKey('3d_experimental')).toBe('3d_experimental');
  });

  it('gives the usage endpoint and the stream the same key for one window', () => {
    const fromUsage = windowFromLimitEntry({ kind: 'five_hour', percent: 50 });
    const fromStream = limitWindowsFromEvent({
      type: 'message_limit',
      message_limit: { windows: { '5h': { status: 'ok', utilization: 0.5 } } },
    });

    expect(fromUsage?.key).toBe(fromStream?.[0]?.key);
  });
});

/* ---- Refusals ------------------------------------------------------------ */

describe('limitWindowsFromRefusal', () => {
  it('digs the limit report out of the double-encoded error message', () => {
    const inner = JSON.stringify({
      type: 'message_limit',
      message_limit: {
        windows: { '5h': { status: 'exceeded_limit', resets_at: RESET_SECONDS, utilization: 1 } },
      },
    });
    const body = JSON.stringify({ error: { type: 'rate_limit_error', message: inner } });

    const windows = limitWindowsFromRefusal(body);

    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.key).toBe('5h');
    expect(windows?.[0]?.status).toBe('exceeded');
    expect(windows?.[0]?.resetsAt).toBe(RESET_SECONDS * 1000);
  });

  it('reads a report that was nested but not re-encoded', () => {
    const windows = limitWindowsFromRefusal({
      error: { message: { windows: { '7d': { status: 'exceeded_limit', utilization: 1 } } } },
    });

    expect(windows?.[0]?.key).toBe('7d');
  });

  it('reads a report carried as a limits array', () => {
    const windows = limitWindowsFromRefusal({
      detail: JSON.stringify({ limits: [{ kind: '7d', percent: 100, severity: 'exceeded' }] }),
    });

    expect(windows?.[0]?.utilization).toBe(100);
  });

  it.each([
    JSON.stringify({ error: { type: 'invalid_request', message: 'conversation not found' } }),
    '<html>502 Bad Gateway</html>',
    '{"error":{"message":"{ not json',
    '',
    null,
    undefined,
    42,
  ])('returns null rather than throwing for %p', (body) => {
    expect(limitWindowsFromRefusal(body)).toBeNull();
  });
});

/* ---- URL matching -------------------------------------------------------- */

describe('isCompletionUrl', () => {
  it.each([
    'https://claude.ai/api/organizations/o/chat_conversations/c/completion',
    'https://claude.ai/api/organizations/o/chat_conversations/c/retry_completion',
    '/api/organizations/o/chat_conversations/c/completion?foo=1',
  ])('matches %s', (url) => {
    expect(isCompletionUrl(url)).toBe(true);
  });

  it.each([
    'https://claude.ai/api/organizations/o/chat_conversations/c',
    'https://claude.ai/api/organizations/o/usage',
    'https://example.com/api/organizations/o/chat_conversations/c/completion',
    'not a url at all',
  ])('does not match %s', (url) => {
    expect(isCompletionUrl(url)).toBe(false);
  });
});

/* ---- The usage fetch, with an unverified path ---------------------------- */

describe('fetchUsageResult', () => {
  const realFetch = globalThis.fetch;
  let requested: string[] = [];

  function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
    requested = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return Promise.resolve(handler(url));
    }) as typeof fetch;
  }

  function usageBody(percent: number): Response {
    return new Response(JSON.stringify({ limits: [{ kind: '5h', percent, severity: 'ok' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    resetUsagePathMemo();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('takes the first candidate that answers with limits', async () => {
    stubFetch((url) => (url.endsWith('/usage') ? usageBody(30) : new Response('', { status: 404 })));

    const result = await fetchUsageResult('org-1');

    expect(result).toEqual({
      kind: 'ok',
      windows: [expect.objectContaining({ key: '5h', utilization: 30 })],
      path: USAGE_PATH_CANDIDATES[0],
    });
  });

  it('walks past a 404 to the candidate that exists', async () => {
    stubFetch((url) =>
      url.endsWith('/rate_limits') ? usageBody(12) : new Response('', { status: 404 }),
    );

    const result = await fetchUsageResult('org-1');

    expect(result.kind).toBe('ok');
    expect(requested).toHaveLength(USAGE_PATH_CANDIDATES.length);
  });

  it('remembers the path that worked and goes straight there next time', async () => {
    stubFetch((url) =>
      url.endsWith('/rate_limits') ? usageBody(12) : new Response('', { status: 404 }),
    );
    await fetchUsageResult('org-1');
    requested.length = 0;

    await fetchUsageResult('org-1');

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('/rate_limits');
  });

  it('walks past a 200 that is not the usage endpoint', async () => {
    // An SPA router answers almost anything with an HTML shell, so 200 alone
    // proves nothing. Only a body carrying limits[] counts as a hit.
    stubFetch((url) =>
      url.endsWith('/limits')
        ? usageBody(7)
        : new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const result = await fetchUsageResult('org-1');

    expect(result.kind).toBe('ok');
    expect(requested.at(-1)).toContain('/limits');
  });

  it('stops probing the moment the credentials are refused', async () => {
    stubFetch(() => new Response('', { status: 401 }));

    const result = await fetchUsageResult('org-1');

    expect(result).toEqual({ kind: 'signed-out' });
    expect(requested).toHaveLength(1);
  });

  it('reports every candidate failing as unavailable, not as a throw', async () => {
    stubFetch(() => new Response('', { status: 404 }));

    await expect(fetchUsageResult('org-1')).resolves.toEqual({
      kind: 'unavailable',
      message: 'HTTP 404',
    });
  });

  it('reports a network that is not there as unavailable', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('Failed to fetch'))) as typeof fetch;

    await expect(fetchUsageResult('org-1')).resolves.toEqual({
      kind: 'unavailable',
      message: 'Failed to fetch',
    });
  });

  it('returns the windows it can read and drops the ones it cannot', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ limits: [{ kind: '5h', percent: 20 }, { nonsense: true }] }), {
          status: 200,
        }),
    );

    const result = await fetchUsageResult('org-1');

    expect(result.kind === 'ok' && result.windows).toHaveLength(1);
  });

  it('escapes the organisation into the path', async () => {
    stubFetch(() => usageBody(1));

    await fetchUsageResult('org/../../etc');

    expect(requested[0]).toBe('https://claude.ai/api/organizations/org%2F..%2F..%2Fetc/usage');
  });
});

import { describe, expect, it } from 'vitest';
import {
  deleteWebhook,
  dispatch,
  nextOffset,
  pollOnce,
  POLL_TIMEOUT_S,
  type PolledUpdate,
} from '../relay/polling';
import { createMemoryStore } from '../relay/memory-store';
import type { Context } from '../relay/commands';

const config = { botToken: 'BOT:TOKEN', webhookSecret: 'unused' };

function respondWith(status: number, body: unknown = {}) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('offset tracking', () => {
  it('acknowledges by asking for one past the highest id', () => {
    // Forgetting this replays the whole backlog on every request, forever.
    const updates: PolledUpdate[] = [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }];
    expect(nextOffset(updates, 0)).toBe(13);
  });

  it('takes the highest id rather than the last, since order is not promised', () => {
    const updates: PolledUpdate[] = [{ update_id: 12 }, { update_id: 10 }, { update_id: 11 }];
    expect(nextOffset(updates, 0)).toBe(13);
  });

  it('holds position when nothing arrived', () => {
    expect(nextOffset([], 13)).toBe(13);
    expect(nextOffset([], 0)).toBe(0);
  });
});

describe('pollOnce', () => {
  it('long-polls with a timeout and narrowed update types', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }) as unknown as typeof fetch;

    await pollOnce(config, 42, capture);

    expect(body['offset']).toBe(42);
    expect(body['timeout']).toBe(POLL_TIMEOUT_S);
    expect(body['allowed_updates']).toEqual(['message']);
  });

  it('reports a registered webhook as its own failure, not a generic one', async () => {
    // The two transports are mutually exclusive, and a bare "failed" here is
    // how an afternoon disappears.
    const result = await pollOnce(config, 0, respondWith(409));
    expect(result).toEqual({ ok: false, failure: 'webhook-conflict' });
  });

  it('distinguishes a bad token', async () => {
    expect(await pollOnce(config, 0, respondWith(401))).toEqual({
      ok: false,
      failure: 'bad-token',
    });
  });

  it('returns updates, and tolerates a body without a result array', async () => {
    const ok = await pollOnce(config, 0, respondWith(200, { result: [{ update_id: 1 }] }));
    expect(ok).toEqual({ ok: true, updates: [{ update_id: 1 }] });

    expect(await pollOnce(config, 0, respondWith(200, {}))).toEqual({ ok: true, updates: [] });
  });

  it('never throws on a network failure', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await pollOnce(config, 0, failing)).toEqual({ ok: false, failure: 'failed' });
  });
});

describe('deleteWebhook', () => {
  it('does not drop pending updates', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    await deleteWebhook(config, capture);

    // Those are somebody's messages. Switching transports is not a reason to
    // discard a queued /forget.
    expect(body['drop_pending_updates']).toBe(false);
  });
});

describe('dispatch', () => {
  const sent: string[] = [];
  const captureSend = (async (_url: string, init: RequestInit) => {
    sent.push(String((JSON.parse(String(init.body)) as { text: string }).text));
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;

  function context(): Context {
    return {
      store: createMemoryStore(),
      now: 1_800_000_000_000,
      today: '2026-08-25',
      random: () => 0.5,
    };
  }

  it('runs a polled update through the same handlers as the webhook', async () => {
    sent.length = 0;
    const reply = await dispatch({ update_id: 1, message: { text: '/start', chat: { id: 7 } } }, config, context(), captureSend);

    expect(reply).toContain('connect code');
    expect(sent[0]).toContain('connect code');
  });

  it('ignores an update with no chat', async () => {
    const reply = await dispatch({ update_id: 1, message: { text: 'hi' } }, config, context(), captureSend);
    expect(reply).toBeNull();
  });
});

describe('memory store', () => {
  it('ranks seeded participants through the real ranking code', async () => {
    const store = createMemoryStore();
    const row = (day: string, input: number, output: number) => ({
      day,
      sessions: 1,
      counters: { input, output, cacheCreation: 0, cacheRead: 0 },
    });

    store.seed(1, 'amber-ledger-0042', [row('2026-08-25', 900, 900)]);
    store.seed(2, 'quiet-heron-0111', [row('2026-08-25', 100, 100)]);

    const board = await store.board('week', '2026-08-25', 10);
    expect(board.map((s) => s.name)).toEqual(['amber-ledger-0042', 'quiet-heron-0111']);
    expect(board[0]?.rank).toBe(1);

    const standing = await store.standing('quiet-heron-0111', 'week', '2026-08-25');
    expect(standing?.rank).toBe(2);
  });

  it('folds names when answering the taken check', async () => {
    const store = createMemoryStore();
    await store.createProfile(1, 'ash');
    expect(await store.isNameTaken('ash')).toBe(true);
    expect(await store.isNameTaken('asher')).toBe(false);
  });

  it('forgets a chat completely', async () => {
    const store = createMemoryStore();
    await store.createProfile(1, 'ash');
    await store.saveCode(1, 'K7QM2XPD', 0);

    await store.forget(1);

    expect(await store.profile(1)).toBeNull();
    expect(store.codes).toHaveLength(0);
  });
});

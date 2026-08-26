import { describe, expect, it } from 'vitest';
import { configFromEnv, createSupabaseStore, hashToken } from '../server/supabase-store';
import { fold } from '../leaderboard/names';

const config = { url: 'https://project.supabase.co', serviceKey: 'service-role-key' };

const TOKEN = 'participant-token';
const HASH = hashToken(TOKEN);

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fake PostgREST. `routes` maps a path fragment to the rows it answers. */
function rest(routes: Record<string, unknown[]> = {}, mint = () => TOKEN) {
  const calls: Call[] = [];

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body === undefined ? null : JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    const match = Object.keys(routes).find((fragment) => String(url).includes(fragment));
    const rows = match === undefined ? [] : routes[match];
    return new Response(JSON.stringify(rows ?? []), { status: 200 });
  }) as unknown as typeof fetch;

  return { calls, store: createSupabaseStore(config, fetchImpl, mint) };
}

describe('configFromEnv', () => {
  it('names the missing variable rather than failing vaguely', () => {
    expect(() => configFromEnv({})).toThrow('SUPABASE_URL');
    expect(() => configFromEnv({ SUPABASE_URL: 'https://x.supabase.co' })).toThrow(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
  });

  it('trims a trailing slash so paths do not double up', () => {
    const parsed = configFromEnv({
      SUPABASE_URL: 'https://x.supabase.co/',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    });
    expect(parsed.url).toBe('https://x.supabase.co');
  });
});

describe('authentication', () => {
  it('sends the service key as both apikey and bearer', async () => {
    const { calls, store } = rest();
    await store.profile(TOKEN);

    expect(calls[0]?.headers['apikey']).toBe('service-role-key');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer service-role-key');
  });
});

describe('tokens', () => {
  it('never sends a plaintext token to the database', async () => {
    // A stolen database must not yield working credentials. Every path that
    // takes a token has to hash it on the way in.
    const { calls, store } = rest();
    await store.profile(TOKEN);
    await store.saveDaily(TOKEN, { day: '2026-08-25', messages: 5 });
    await store.forget(TOKEN);

    for (const call of calls) {
      expect(call.url, call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? {}), call.url).not.toContain(TOKEN);
    }
    expect(calls.some((call) => call.url.includes(HASH))).toBe(true);
  });

  it('hashes deterministically, or a returning participant is a stranger', () => {
    expect(hashToken(TOKEN)).toBe(hashToken(TOKEN));
    expect(hashToken(TOKEN)).not.toBe(hashToken(`${TOKEN}x`));
    expect(hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('enrolling', () => {
  it('writes the folded name alongside the display name', async () => {
    // Uniqueness is decided on the folded column. Writing only `name` would
    // make the whole confusable defence decorative.
    const { calls, store } = rest();
    const enrolment = await store.enroll(() => 'Ash_Padhi');

    expect(enrolment).toEqual({ token: TOKEN, name: 'Ash_Padhi' });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['name']).toBe('Ash_Padhi');
    expect(body['name_folded']).toBe(fold('Ash_Padhi'));
    expect(body['token_hash']).toBe(HASH);
  });

  it('retries with a fresh proposal when the unique index refuses one', async () => {
    // The insert is the uniqueness check: reading first and then writing would
    // let two concurrent enrolments take the same name.
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      return attempt === 1
        ? new Response('duplicate key value', { status: 409 })
        : new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const store = createSupabaseStore(config, fetchImpl, () => TOKEN);
    const names = ['taken', 'free'];
    let index = 0;

    const enrolment = await store.enroll(() => names[index++] ?? 'fallback');
    expect(enrolment?.name).toBe('free');
    expect(attempt).toBe(2);
  });

  it('gives up rather than looping forever on a full namespace', async () => {
    const failing = (async () =>
      new Response('duplicate key value', { status: 409 })) as unknown as typeof fetch;

    const store = createSupabaseStore(config, failing, () => TOKEN);
    expect(await store.enroll(() => 'taken')).toBeNull();
  });

  it('raises anything that is not a name conflict on the first attempt', async () => {
    // Retrying a permanent failure — a column that does not exist, a key that
    // is not accepted — spends twenty sequential round trips and then the
    // function's whole time budget, and reaches the user as "could not reach
    // the leaderboard". It has to fail fast and say what happened.
    let attempts = 0;
    const failing = (async () => {
      attempts += 1;
      return new Response('column "token_hash" does not exist', { status: 400 });
    }) as unknown as typeof fetch;

    const store = createSupabaseStore(config, failing, () => TOKEN);
    await expect(store.enroll(() => 'ash')).rejects.toThrow('supabase 400 on profiles');
    expect(attempts).toBe(1);
  });
});

describe('profiles', () => {
  it('reads a profile by token', async () => {
    const { store } = rest({ [`profiles?token_hash=eq.${HASH}`]: [{ name: 'ash' }] });
    expect(await store.profile(TOKEN)).toEqual({ name: 'ash' });
  });

  it('returns null for a token with no profile', async () => {
    const { store } = rest();
    expect(await store.profile(TOKEN)).toBeNull();
  });
});

describe('submitting', () => {
  it('upserts, so a resubmission corrects a day instead of doubling it', async () => {
    const { calls, store } = rest();
    await store.saveDaily(TOKEN, { day: '2026-08-25', messages: 42 });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Prefer']).toBe('resolution=merge-duplicates');
    expect(calls[0]?.body).toEqual({ token_hash: HASH, day: '2026-08-25', messages: 42 });
  });
});

describe('boards', () => {
  const profiles = [
    { token_hash: 'a', name: 'worker' },
    { token_hash: 'b', name: 'idler' },
  ];
  const row = (token: string, day: string, messages: number) => ({
    token_hash: token,
    day,
    messages,
  });

  it('joins rows to profiles on the token hash', async () => {
    const { store } = rest({
      profiles,
      daily_rows: [row('a', '2026-08-25', 300), row('a', '2026-08-24', 200)],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.name).toBe('worker');
    expect(board[0]?.ranked).toBe(500);
    expect(board[0]?.days).toBe(2);
  });

  it('ignores rows whose token has no profile', async () => {
    // An orphan row belongs to nobody and must not be attributed to anybody.
    const { store } = rest({
      profiles: [{ token_hash: 'a', name: 'worker' }],
      daily_rows: [row('a', '2026-08-25', 20), row('ghost', '2026-08-25', 9_999)],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.ranked).toBe(20);
  });

  it('finds a standing by name', async () => {
    const { store } = rest({
      profiles,
      daily_rows: [row('a', '2026-08-25', 500), row('b', '2026-08-25', 10)],
    });

    const stats = await store.stats('idler', '2026-08-25');
    expect(stats?.standings.get('all')?.rank).toBe(2);
  });

  it('answers a whole profile page in one pass over the tables', async () => {
    // Three periods and a streak used to be three `standing` calls, each of
    // which reloaded and re-ranked every participant: six table reads for one
    // page, and no streak at the end of it.
    const { calls, store } = rest({
      profiles,
      daily_rows: [row('a', '2026-08-24', 300), row('a', '2026-08-25', 200)],
    });

    const stats = await store.stats('worker', '2026-08-25');
    expect(stats?.standings.get('all')?.ranked).toBe(500);
    expect(stats?.streak).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe('leaving', () => {
  it('deletes rows before the profile they hang off', async () => {
    // The other order leaves rows keyed by a hash nothing points at any more:
    // invisible to the board, which reads through profiles, and undeletable.
    const { calls, store } = rest();
    await store.forget(TOKEN);

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    const rows = deletes.findIndex((url) => url.includes('daily_rows'));
    const profile = deletes.findIndex((url) => url.includes('profiles'));

    expect(rows).toBeGreaterThanOrEqual(0);
    expect(profile).toBeGreaterThan(rows);
  });

  it('leaves nothing behind to prove somebody was there', async () => {
    const { calls, store } = rest();
    await store.forget(TOKEN);

    // No tombstone, no soft-delete flag. Only deletes.
    expect(calls.every((call) => call.method === 'DELETE')).toBe(true);
  });
});

describe('failures', () => {
  it('raises with the status and table, and quotes no row data', async () => {
    const failing = (async () =>
      new Response('duplicate key value violates unique constraint "profiles_name_folded_key"', {
        status: 409,
      })) as unknown as typeof fetch;

    const store = createSupabaseStore(config, failing, () => TOKEN);
    await expect(store.saveDaily(TOKEN, { day: '2026-08-25', messages: 1 })).rejects.toThrow(
      'supabase 409 on daily_rows',
    );
  });

  it('treats a 204 with no body as an empty result', async () => {
    const empty = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const store = createSupabaseStore(config, empty, () => TOKEN);
    await expect(store.forget(TOKEN)).resolves.toBeUndefined();
  });
});

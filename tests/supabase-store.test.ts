import { describe, expect, it } from 'vitest';
import { configFromEnv, createSupabaseStore, hashToken } from '../server/supabase-store';
import { fold } from '../leaderboard/names';

const config = { url: 'https://project.supabase.co', serviceKey: 'service-role-key' };

const TOKEN = 'participant-token';
const HASH = hashToken(TOKEN);
const ASH = 'ash@example.com';

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
    const { calls, store } = rest({ 'tokens?token_hash=eq.': [{ email: ASH }] });
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
    const enrolment = await store.enroll(ASH, () => 'Ash_Padhi');

    expect(enrolment).toEqual({ token: TOKEN, name: 'Ash_Padhi', existing: false });

    // The first call looks the account up; the second creates the profile.
    const insert = calls.find((call) => call.method === 'POST' && call.url.includes('profiles'));
    const body = insert?.body as Record<string, unknown>;
    expect(body['email']).toBe(ASH);
    expect(body['name']).toBe('Ash_Padhi');
    expect(body['name_folded']).toBe(fold('Ash_Padhi'));
  });

  it('gives a second browser on one account the existing name', async () => {
    // One Claude account is one public profile, however many browsers sign
    // into it. The proposal is not even consulted.
    const { store } = rest({ 'profiles?email=eq.': [{ name: 'amber-ledger-0042' }] });

    expect(await store.enroll(ASH, () => 'never-used')).toEqual({
      token: TOKEN,
      name: 'amber-ledger-0042',
      existing: true,
    });
  });

  it('binds each browser token to the account rather than to a profile row', async () => {
    const { calls, store } = rest({ 'profiles?email=eq.': [{ name: 'held' }] });
    await store.enroll(ASH, () => 'unused');

    const bind = calls.find((call) => call.method === 'POST' && call.url.includes('tokens'));
    expect(bind?.body).toEqual({ token_hash: HASH, email: ASH });
  });

  /**
   * A fake that tells the account lookup apart from the profile insert.
   *
   * `enroll` reads the account first and only then writes, so a fake that
   * answers every request identically cannot express "the lookup found nothing
   * and the insert was refused" — which is the case every test below is about.
   */
  function enrolling(onInsert: (attempt: number) => Response) {
    let inserts = 0;
    const calls: string[] = [];

    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${String(url)}`);

      if (method === 'GET') return new Response('[]', { status: 200 });
      if (String(url).includes('tokens')) return new Response('[]', { status: 200 });

      inserts += 1;
      return onInsert(inserts);
    }) as unknown as typeof fetch;

    return { calls, inserts: () => inserts, store: createSupabaseStore(config, fetchImpl, () => TOKEN) };
  }

  it('retries with a fresh proposal when the unique index refuses one', async () => {
    // The insert is the uniqueness check: reading the name first and then
    // writing would let two concurrent enrolments take the same one.
    const { store } = enrolling((attempt) =>
      attempt === 1
        ? new Response('duplicate key value', { status: 409 })
        : new Response('[]', { status: 200 }),
    );

    const names = ['taken', 'free'];
    let index = 0;

    const enrolment = await store.enroll(ASH, () => names[index++] ?? 'fallback');
    expect(enrolment?.name).toBe('free');
    expect(enrolment?.existing).toBe(false);
  });

  it('gives up rather than looping forever on a full namespace', async () => {
    const { store } = enrolling(() => new Response('duplicate key value', { status: 409 }));
    expect(await store.enroll(ASH, () => 'taken')).toBeNull();
  });

  it('raises anything that is not a name conflict on the first attempt', async () => {
    // Retrying a permanent failure — a column that does not exist, a key that
    // is not accepted — spends twenty sequential round trips and then the
    // function's whole time budget, and reaches the user as "could not reach
    // the leaderboard". It has to fail fast and say what happened.
    const { store, inserts } = enrolling(
      () => new Response('column "email" does not exist', { status: 400 }),
    );

    await expect(store.enroll(ASH, () => 'ash')).rejects.toThrow('supabase 400 on profiles');
    expect(inserts()).toBe(1);
  });
});

describe('profiles', () => {
  it('reads a profile by token, through the account it is bound to', async () => {
    const { store } = rest({
      'tokens?token_hash=eq.': [{ email: ASH }],
      'profiles?email=eq.': [{ name: 'ash' }],
    });
    expect(await store.profile(TOKEN)).toEqual({ name: 'ash' });
  });

  it('returns null for a token with no profile', async () => {
    const { store } = rest();
    expect(await store.profile(TOKEN)).toBeNull();
  });
});

describe('submitting', () => {
  it('upserts, so a resubmission corrects a day instead of doubling it', async () => {
    const { calls, store } = rest({ 'tokens?token_hash=eq.': [{ email: ASH }] });
    await store.saveDaily(TOKEN, { day: '2026-08-25', messages: 42 });

    const write = calls.find((call) => call.url.includes('daily_rows'));
    expect(write?.method).toBe('POST');
    expect(write?.headers['Prefer']).toBe('resolution=merge-duplicates');
    expect(write?.body).toEqual({ email: ASH, day: '2026-08-25', messages: 42 });
  });

  it('writes nothing for a token nobody holds', async () => {
    const { calls, store } = rest();
    await store.saveDaily('stranger', { day: '2026-08-25', messages: 42 });
    expect(calls.some((call) => call.url.includes('daily_rows'))).toBe(false);
  });
});

describe('boards', () => {
  const profiles = [
    { email: 'worker@example.com', name: 'worker' },
    { email: 'idler@example.com', name: 'idler' },
  ];
  const row = (email: string, day: string, messages: number) => ({ email, day, messages });

  it('joins rows to profiles on the account email', async () => {
    const { store } = rest({
      profiles,
      daily_rows: [
        row('worker@example.com', '2026-08-25', 300),
        row('worker@example.com', '2026-08-24', 200),
      ],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.name).toBe('worker');
    expect(board[0]?.ranked).toBe(500);
    expect(board[0]?.days).toBe(2);
  });

  it('ignores rows whose account has no profile', async () => {
    // An orphan row belongs to nobody and must not be attributed to anybody.
    const { store } = rest({
      profiles: [{ email: 'worker@example.com', name: 'worker' }],
      daily_rows: [
        row('worker@example.com', '2026-08-25', 20),
        row('ghost@example.com', '2026-08-25', 9_999),
      ],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.ranked).toBe(20);
  });

  it('finds a standing by name', async () => {
    const { store } = rest({
      profiles,
      daily_rows: [
        row('worker@example.com', '2026-08-25', 500),
        row('idler@example.com', '2026-08-25', 10),
      ],
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
      daily_rows: [
        row('worker@example.com', '2026-08-24', 300),
        row('worker@example.com', '2026-08-25', 200),
      ],
    });

    const stats = await store.stats('worker', '2026-08-25');
    expect(stats?.standings.get('all')?.ranked).toBe(500);
    expect(stats?.streak).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe('leaving', () => {
  it('deletes rows and tokens before the profile they hang off', async () => {
    // The other order leaves rows keyed on an account nothing points at any
    // more: invisible to the board, which reads through profiles, and
    // undeletable.
    const { calls, store } = rest({ 'tokens?token_hash=eq.': [{ email: ASH }] });
    await store.forget(TOKEN);

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    const rows = deletes.findIndex((url) => url.includes('daily_rows'));
    const tokens = deletes.findIndex((url) => url.includes('tokens'));
    const profile = deletes.findIndex((url) => url.includes('profiles'));

    expect(rows).toBeGreaterThanOrEqual(0);
    expect(profile).toBeGreaterThan(rows);
    expect(profile).toBeGreaterThan(tokens);
  });

  it('unbinds every browser on the account, not just the one that asked', async () => {
    // Leave says the profile is gone. Deleting only the calling token would
    // leave the public page up and another browser still publishing to it.
    const { calls, store } = rest({ 'tokens?token_hash=eq.': [{ email: ASH }] });
    await store.forget(TOKEN);

    const tokenDelete = calls.find(
      (call) => call.method === 'DELETE' && call.url.includes('tokens'),
    );
    expect(tokenDelete?.url).toContain(`email=eq.${encodeURIComponent(ASH)}`);
    expect(tokenDelete?.url).not.toContain('token_hash');
  });

  it('leaves nothing behind to prove somebody was there', async () => {
    const { calls, store } = rest({ 'tokens?token_hash=eq.': [{ email: ASH }] });
    await store.forget(TOKEN);

    // No tombstone, no soft-delete flag. One lookup, then only deletes.
    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes.every((call) => call.method === 'DELETE')).toBe(true);
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
      'supabase 409 on tokens',
    );
  });

  it('treats a 204 with no body as an empty result', async () => {
    const empty = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const store = createSupabaseStore(config, empty, () => TOKEN);
    await expect(store.forget(TOKEN)).resolves.toBeUndefined();
  });
});

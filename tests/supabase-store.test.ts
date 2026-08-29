import { describe, expect, it, vi } from 'vitest';
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
  it('uses one transactional RPC after the read-only account lookup', async () => {
    const { calls, store } = rest({
      'rpc/enroll_profile': [{ name: 'ash-padhi', existing: false }],
    });

    expect(await store.enroll(ASH, () => 'ash-padhi')).toEqual({
      token: TOKEN,
      name: 'ash-padhi',
      existing: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('profiles?email=eq.');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/rest/v1/rpc/enroll_profile');
    expect(calls[1]?.body).toEqual({
      p_email: ASH,
      p_name: 'ash-padhi',
      p_name_folded: fold('ash-padhi'),
      p_token_hash: HASH,
    });
    expect(calls.some((call) => /\/rest\/v1\/(profiles|tokens)$/.test(call.url))).toBe(false);
  });

  it('sends only the hash to the database and returns the locally minted token', async () => {
    const { calls, store } = rest({
      'rpc/enroll_profile': [{ name: 'held', existing: false }],
    });

    const result = await store.enroll(ASH, () => 'held');
    expect(result?.token).toBe(TOKEN);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body)).not.toContain(TOKEN);
    }
    expect(calls[1]?.body).toMatchObject({ p_token_hash: HASH });
  });

  it('does not assign for an existing account and atomically mints another browser token', async () => {
    const assign = vi.fn(() => 'never-used');
    const { calls, store } = rest({
      'profiles?email=eq.': [{ name: 'amber-ledger-0042' }],
      'rpc/enroll_profile': [{ name: 'amber-ledger-0042', existing: true }],
    });

    expect(await store.enroll(ASH, assign)).toEqual({
      token: TOKEN,
      name: 'amber-ledger-0042',
      existing: true,
    });
    expect(assign).not.toHaveBeenCalled();
    expect(calls[1]?.body).toEqual({
      p_email: ASH,
      p_name: null,
      p_name_folded: null,
      p_token_hash: HASH,
    });
  });

  it('accepts the exact winning name when a concurrent first enrolment wins the email lock', async () => {
    const { calls, store } = rest({
      'rpc/enroll_profile': [{ name: 'winner-name-0042', existing: true }],
    });

    expect(await store.enroll(ASH, () => 'losing-candidate-0001')).toEqual({
      token: TOKEN,
      name: 'winner-name-0042',
      existing: true,
    });
    expect(calls).toHaveLength(2);
  });

  function enrolling(onRpc: (attempt: number) => Response) {
    let attempts = 0;
    const calls: Call[] = [];

    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({
        url: String(url),
        method,
        body: init.body === undefined ? null : JSON.parse(String(init.body)),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (method === 'GET') return new Response('[]', { status: 200 });
      attempts += 1;
      return onRpc(attempts);
    }) as unknown as typeof fetch;

    return {
      calls,
      attempts: () => attempts,
      store: createSupabaseStore(config, fetchImpl, () => TOKEN),
    };
  }

  it('retries only the RPC candidate-name PT409 with a fresh proposal', async () => {
    const { calls, store } = enrolling((attempt) =>
      attempt === 1
        ? new Response('{"code":"PT409","message":"candidate name unavailable"}', {
            status: 409,
          })
        : new Response('[{"name":"free","existing":false}]', { status: 200 }),
    );
    const names = ['taken', 'free'];
    let index = 0;

    expect(await store.enroll(ASH, () => names[index++] ?? 'fallback')).toEqual({
      token: TOKEN,
      name: 'free',
      existing: false,
    });
    expect(calls.filter((call) => call.url.includes('rpc/enroll_profile'))).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ p_name: 'taken' });
    expect(calls[2]?.body).toMatchObject({ p_name: 'free' });
  });

  it('returns null after twenty explicit candidate conflicts', async () => {
    const { store, attempts } = enrolling(
      () => new Response('{"code":"PT409"}', { status: 409 }),
    );
    await expect(store.enroll(ASH, () => 'taken')).resolves.toBeNull();
    expect(attempts()).toBe(20);
  });

  it.each([
    [409, '{"code":"23505"}', 'token collision'],
    [400, '{"code":"22023"}', 'invalid input'],
    [500, '{"code":"XX000"}', 'server failure'],
  ])('propagates a non-name RPC %s on the first attempt (%s)', async (status, body) => {
    const { store, attempts } = enrolling(() => new Response(body, { status }));

    await expect(store.enroll(ASH, () => 'candidate')).rejects.toThrow(
      `supabase ${String(status)} on rpc/enroll_profile`,
    );
    expect(attempts()).toBe(1);
  });

  it('rejects an empty or malformed RPC result instead of inventing enrollment state', async () => {
    const { store } = rest({ 'rpc/enroll_profile': [] });
    await expect(store.enroll(ASH, () => 'candidate')).rejects.toThrow(
      'supabase invalid response on rpc/enroll_profile',
    );
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
  it('uses one atomic RPC with only the hashed token', async () => {
    const { calls, store } = rest();
    await store.forget(TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/rest/v1/rpc/forget_profile');
    expect(calls[0]?.body).toEqual({ p_token_hash: HASH });
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(TOKEN);
  });

  it('treats an unknown or already-forgotten token as a successful no-op', async () => {
    // The scalar false is the function's result for no matching profile.
    // The adapter intentionally does not distinguish it: Leave is idempotent
    // and must not expose whether an account used to exist.
    const fetchImpl = (async () =>
      new Response('false', { status: 200 })) as unknown as typeof fetch;
    const store = createSupabaseStore(config, fetchImpl, () => TOKEN);

    await expect(store.forget('not-held')).resolves.toBeUndefined();
  });

  it('does not hide a missing RPC as an unknown token', async () => {
    const missing = (async () =>
      new Response('{"code":"PGRST202"}', { status: 404 })) as unknown as typeof fetch;
    const store = createSupabaseStore(config, missing, () => TOKEN);

    await expect(store.forget('not-held')).rejects.toThrow(
      'supabase 404 on rpc/forget_profile',
    );
  });

  it('does not issue direct table deletes that could commit independently', async () => {
    const { calls, store } = rest();
    await store.forget(TOKEN);

    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(calls.some((call) => /\/(profiles|tokens|daily_rows)\?/.test(call.url))).toBe(false);
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

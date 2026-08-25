import { describe, expect, it } from 'vitest';
import { configFromEnv, createSupabaseStore } from '../relay/supabase-store';
import { fold } from '../leaderboard/names';

const config = { url: 'https://project.supabase.co', serviceKey: 'service-role-key' };

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A fake PostgREST. `routes` maps a path fragment to the rows it answers. */
function rest(routes: Record<string, unknown[]> = {}) {
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

  return { calls, store: createSupabaseStore(config, fetchImpl) };
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
    await store.profile(42);

    expect(calls[0]?.headers['apikey']).toBe('service-role-key');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer service-role-key');
  });
});

describe('profiles', () => {
  it('reads a profile by chat', async () => {
    const { store } = rest({ 'profiles?chat_id=eq.42': [{ name: 'ash', digest: true }] });
    expect(await store.profile(42)).toEqual({ name: 'ash', digest: true });
  });

  it('returns null for a chat with no profile', async () => {
    const { store } = rest();
    expect(await store.profile(42)).toBeNull();
  });

  it('writes the folded name alongside the display name', async () => {
    // Uniqueness is decided on the folded column. Writing only `name` would
    // make the whole confusable defence decorative.
    const { calls, store } = rest();
    await store.createProfile(42, 'Ash_Padhi');

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['name']).toBe('Ash_Padhi');
    expect(body['name_folded']).toBe(fold('Ash_Padhi'));
  });

  it('keeps the folded name in step on a rename', async () => {
    const { calls, store } = rest();
    await store.setName(42, 'newname');

    expect(calls[0]?.method).toBe('PATCH');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['name_folded']).toBe(fold('newname'));
  });

  it('asks the folded column when checking whether a name is taken', async () => {
    const { calls, store } = rest();
    await store.isNameTaken('ash');

    expect(calls[0]?.url).toContain('name_folded=eq.ash');
  });
});

describe('rename codes', () => {
  it('redeems conditionally, so two attempts cannot both win', async () => {
    // A read-then-write would let concurrent redemptions both succeed. The
    // filter carries the condition instead.
    const { calls, store } = rest({ rename_codes: [{ code: 'K7QM2XPD' }] });
    expect(await store.redeemRenameCode('K7QM2XPD')).toBe(true);

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('redeemed=is.false');
    expect(calls[0]?.headers['Prefer']).toBe('return=representation');
  });

  it('reports a code that updated nothing as unusable', async () => {
    const { store } = rest();
    expect(await store.redeemRenameCode('SPENT')).toBe(false);
  });
});

describe('boards', () => {
  const profiles = [
    { chat_id: 1, name: 'worker' },
    { chat_id: 2, name: 'idler' },
  ];
  const connections = [
    { token_hash: 'a', chat_id: 1 },
    { token_hash: 'b', chat_id: 1 },
    { token_hash: 'c', chat_id: 2 },
  ];
  const row = (token: string, day: string, input: number, output: number) => ({
    token_hash: token,
    day,
    input,
    output,
    cache_creation: 0,
    cache_read: 0,
    sessions: 1,
  });

  it('aggregates two installations of one chat into one row', async () => {
    // ADR 0006: multiple tokens for one chat are one profile. Listing them
    // separately would show somebody twice, each at half strength.
    const { store } = rest({
      profiles: profiles,
      connections,
      daily_rows: [row('a', '2026-08-25', 300, 300), row('b', '2026-08-25', 200, 200)],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.name).toBe('worker');
    expect(board[0]?.ranked).toBe(1_000);
  });

  it('ignores rows whose token has no connection', async () => {
    // An orphan row belongs to nobody and must not be attributed to anybody.
    const { store } = rest({
      profiles: profiles,
      connections: [{ token_hash: 'a', chat_id: 1 }],
      daily_rows: [row('a', '2026-08-25', 10, 10), row('ghost', '2026-08-25', 9_999, 9_999)],
    });

    const board = await store.board('all', '2026-08-25', 10);
    expect(board).toHaveLength(1);
    expect(board[0]?.ranked).toBe(20);
  });

  it('finds a standing by name', async () => {
    const { store } = rest({
      profiles: profiles,
      connections,
      daily_rows: [row('a', '2026-08-25', 500, 500), row('c', '2026-08-25', 10, 10)],
    });

    expect((await store.standing('idler', 'all', '2026-08-25'))?.rank).toBe(2);
  });
});

describe('leaving', () => {
  it('optout deletes rows and the profile but never the connections', async () => {
    // Opting out of the board is not disconnecting alerts. Conflating them
    // would silently switch off something the user still wants.
    const { calls, store } = rest({ connections: [{ token_hash: 'a' }] });
    await store.deleteProfile(42);

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    expect(deletes.some((url) => url.includes('daily_rows'))).toBe(true);
    expect(deletes.some((url) => url.includes('profiles'))).toBe(true);
    expect(deletes.some((url) => url.includes('connections'))).toBe(false);
  });

  it('forget deletes rows before the connections they are keyed by', async () => {
    // The other order loses the token hashes and orphans the rows for good.
    const { calls, store } = rest({ connections: [{ token_hash: 'a' }] });
    await store.forget(42);

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    const rows = deletes.findIndex((url) => url.includes('daily_rows'));
    const conns = deletes.findIndex((url) => url.includes('connections'));

    expect(rows).toBeGreaterThanOrEqual(0);
    expect(conns).toBeGreaterThan(rows);
    expect(deletes.some((url) => url.includes('codes'))).toBe(true);
  });
});

describe('failures', () => {
  it('raises with the status and table, and quotes no row data', async () => {
    const failing = (async () =>
      new Response('duplicate key value violates unique constraint "profiles_name_folded_key"', {
        status: 409,
      })) as unknown as typeof fetch;

    const store = createSupabaseStore(config, failing);
    await expect(store.createProfile(1, 'ash')).rejects.toThrow('supabase 409 on profiles');
  });

  it('treats a 204 with no body as an empty result', async () => {
    const empty = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const store = createSupabaseStore(config, empty);
    await expect(store.setDigest(1, true)).resolves.toBeUndefined();
  });
});

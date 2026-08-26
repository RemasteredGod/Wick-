/**
 * `RelayStore` over Supabase, through PostgREST and nothing else.
 *
 * **No SDK.** Supabase's REST layer is HTTPS and JSON, and the argument against
 * wrapping the Telegram API applies here with more force: this client holds the
 * service-role key, which bypasses row level security and can read every row in
 * the database. A dependency that sits between that key and the wire is a third
 * party with total access, added to save writing `fetch` calls.
 *
 * Going over HTTP also sidesteps the classic serverless-plus-Postgres failure.
 * Direct connections need a pooler because functions scale horizontally and
 * each instance opens its own; PostgREST is stateless, so there is no pool to
 * exhaust and nothing to configure.
 *
 * The service-role key must only ever exist server-side. Every call here runs
 * inside a Vercel function; nothing in this file may be imported by anything
 * that reaches a browser.
 */

import { fold } from '../leaderboard/names.js';
import { board as rankBoard, standingFor, type Participant, type Standing } from '../leaderboard/ranking.js';
import type { Day, Period } from '../leaderboard/periods.js';
import type { DailyRow } from '../leaderboard/submission.js';
import type { Profile, RelayStore } from './store.js';

export interface SupabaseConfig {
  /** `https://<project>.supabase.co` — no trailing slash. */
  url: string;
  /** The **service role** key. Never the anon key, and never sent to a client. */
  serviceKey: string;
}

/** Read the config from the environment, or say which variable is missing. */
export function configFromEnv(env: Record<string, string | undefined>): SupabaseConfig {
  const url = env['SUPABASE_URL'];
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'];

  if (url === undefined || url === '') throw new Error('SUPABASE_URL is not set');
  if (serviceKey === undefined || serviceKey === '') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  }

  return { url: url.replace(/\/+$/, ''), serviceKey };
}

export function createSupabaseStore(
  config: SupabaseConfig,
  fetchImpl: typeof fetch = fetch,
): RelayStore {
  /** One PostgREST request. Returns parsed rows, or throws with the status. */
  async function rest<T>(
    path: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<T[]> {
    const headers: Record<string, string> = {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    };
    if (init.prefer !== undefined) headers['Prefer'] = init.prefer;

    const response = await fetchImpl(`${config.url}/rest/v1/${path}`, { ...init, headers });

    if (!response.ok) {
      // The body carries PostgREST's own message, which is the only useful part.
      // It is not logged — it can quote row values — but it is worth raising.
      throw new Error(`supabase ${String(response.status)} on ${path.split('?')[0] ?? path}`);
    }

    // DELETE and PATCH without `return=representation` answer 204 with no body.
    if (response.status === 204) return [];

    try {
      return (await response.json()) as T[];
    } catch {
      return [];
    }
  }

  /** Every participant's rows, for the ranking functions. One query, not N. */
  async function participants(): Promise<Participant[]> {
    const [profiles, rows, connections] = await Promise.all([
      rest<{ chat_id: number; name: string }>('profiles?select=chat_id,name'),
      rest<{
        token_hash: string;
        day: string;
        input: number;
        output: number;
        cache_creation: number;
        cache_read: number;
        sessions: number;
      }>('daily_rows?select=token_hash,day,input,output,cache_creation,cache_read,sessions'),
      rest<{ token_hash: string; chat_id: number }>('connections?select=token_hash,chat_id'),
    ]);

    const chatForToken = new Map(connections.map((c) => [c.token_hash, c.chat_id]));

    // Rows are token-scoped and profiles are chat-scoped: one person with two
    // installations has two token hashes and must appear once. ADR 0006 calls
    // this out, and forgetting it would list somebody twice at half strength.
    const byChat = new Map<number, DailyRow[]>();
    for (const row of rows) {
      const chatId = chatForToken.get(row.token_hash);
      if (chatId === undefined) continue;

      const list = byChat.get(chatId) ?? [];
      list.push({
        day: row.day,
        sessions: row.sessions,
        counters: {
          input: row.input,
          output: row.output,
          cacheCreation: row.cache_creation,
          cacheRead: row.cache_read,
        },
      });
      byChat.set(chatId, list);
    }

    return profiles.map((profile) => ({
      name: profile.name,
      rows: byChat.get(profile.chat_id) ?? [],
    }));
  }

  return {
    async saveCode(chatId, code, mintedAt) {
      await rest('codes', {
        method: 'POST',
        body: JSON.stringify({
          code,
          chat_id: chatId,
          minted_at: new Date(mintedAt).toISOString(),
        }),
      });
    },

    async profile(chatId) {
      const rows = await rest<{ name: string; digest: boolean }>(
        `profiles?chat_id=eq.${String(chatId)}&select=name,digest&limit=1`,
      );
      const row = rows[0];
      return row === undefined ? null : { name: row.name, digest: row.digest };
    },

    async createProfile(chatId, name) {
      await rest('profiles', {
        method: 'POST',
        body: JSON.stringify({ chat_id: chatId, name, name_folded: fold(name) }),
      });
    },

    async setName(chatId, name) {
      await rest(`profiles?chat_id=eq.${String(chatId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, name_folded: fold(name) }),
      });
    },

    async setDigest(chatId, on) {
      await rest(`profiles?chat_id=eq.${String(chatId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ digest: on }),
      });
    },

    async isNameTaken(folded) {
      // Asked with the folded form and matched against the folded column. Both
      // halves have to agree or the whole confusable defence is decorative.
      const rows = await rest<{ chat_id: number }>(
        `profiles?name_folded=eq.${encodeURIComponent(folded)}&select=chat_id&limit=1`,
      );
      return rows.length > 0;
    },

    async redeemRenameCode(code) {
      // Conditional update, not read-then-write: `redeemed=is.false` in the
      // filter means two concurrent redemptions cannot both succeed, which a
      // check followed by a write would allow.
      const updated = await rest<{ code: string }>(
        `rename_codes?code=eq.${encodeURIComponent(code)}&redeemed=is.false`,
        {
          method: 'PATCH',
          body: JSON.stringify({ redeemed: true }),
          prefer: 'return=representation',
        },
      );
      return updated.length > 0;
    },

    async board(period: Period, today: Day, size: number): Promise<Standing[]> {
      return rankBoard(await participants(), period, today, size);
    },

    async standing(name: string, period: Period, today: Day): Promise<Standing | null> {
      return standingFor(await participants(), name, period, today);
    },

    async deleteProfile(chatId) {
      // Leaves connections alone: opting out of the board is not disconnecting
      // alerts, and conflating them would silently switch off something the
      // user still wants.
      const tokens = await rest<{ token_hash: string }>(
        `connections?chat_id=eq.${String(chatId)}&select=token_hash`,
      );

      for (const { token_hash } of tokens) {
        await rest(`daily_rows?token_hash=eq.${encodeURIComponent(token_hash)}`, {
          method: 'DELETE',
        });
      }
      await rest(`profiles?chat_id=eq.${String(chatId)}`, { method: 'DELETE' });
    },

    async forget(chatId) {
      // Rows first, then the connections they are keyed by. The other order
      // loses the token hashes and orphans the rows for good.
      const tokens = await rest<{ token_hash: string }>(
        `connections?chat_id=eq.${String(chatId)}&select=token_hash`,
      );

      for (const { token_hash } of tokens) {
        await rest(`daily_rows?token_hash=eq.${encodeURIComponent(token_hash)}`, {
          method: 'DELETE',
        });
      }

      await rest(`profiles?chat_id=eq.${String(chatId)}`, { method: 'DELETE' });
      await rest(`codes?chat_id=eq.${String(chatId)}`, { method: 'DELETE' });
      await rest(`connections?chat_id=eq.${String(chatId)}`, { method: 'DELETE' });
    },
  };
}

/** Profile type re-exported so callers need one import. */
export type { Profile };

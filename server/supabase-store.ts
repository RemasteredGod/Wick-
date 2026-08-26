/**
 * `BoardStore` over Supabase, through PostgREST and nothing else.
 *
 * **No SDK.** Supabase's REST layer is HTTPS and JSON, and this client holds the
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
 *
 * **Tokens are stored hashed.** A stolen database must not yield working
 * credentials, so the column is `sha256(token)` and the plaintext exists only
 * in the response to the enrolment that minted it, and in the extension that
 * holds it afterwards.
 */

import { createHash, randomBytes } from 'node:crypto';
import { fold } from '../leaderboard/names.js';
import {
  board as rankBoard,
  standingFor,
  type Participant,
  type Standing,
} from '../leaderboard/ranking.js';
import type { Day, Period } from '../leaderboard/periods.js';
import type { DailyRow } from '../leaderboard/submission.js';
import type { BoardStore, Profile } from './store.js';

export interface SupabaseConfig {
  /** `https://<project>.supabase.co` — no trailing slash. */
  url: string;
  /** The **service role** key. Never the anon key, and never sent to a client. */
  serviceKey: string;
}

/**
 * Bytes of entropy in a participant token.
 *
 * Thirty-two, because unlike the old connect codes there is no attempt limit
 * behind this and nothing to rate-limit it against — a token is the only thing
 * standing between a stranger and somebody else's rows, and it is never typed
 * by a human, so there is no usability reason to make it shorter.
 */
export const TOKEN_BYTES = 32;

/** How many names to propose before declaring the namespace full. See `enroll`. */
const NAME_ATTEMPTS = 20;

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

/** `sha256(token)`, hex. The only form of a token that touches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSupabaseStore(
  config: SupabaseConfig,
  fetchImpl: typeof fetch = fetch,
  mintToken: () => string = () => randomBytes(TOKEN_BYTES).toString('base64url'),
): BoardStore {
  /** One PostgREST request. Returns parsed rows, or throws a `RestError`. */
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
      throw new RestError(response.status, path.split('?')[0] ?? path);
    }

    // DELETE and PATCH without `return=representation` answer 204 with no body.
    if (response.status === 204) return [];

    try {
      return (await response.json()) as T[];
    } catch {
      return [];
    }
  }

  /**
   * Every participant's rows, for the ranking functions. Two queries, not N.
   *
   * Profiles and rows share `token_hash`, so this is a straight join — the old
   * schema keyed profiles by chat and rows by token, and needed a third table
   * to reconcile them. One token is one participant now, which is what makes
   * the extra hop unnecessary.
   */
  async function participants(): Promise<Participant[]> {
    const [profiles, rows] = await Promise.all([
      rest<{ token_hash: string; name: string }>('profiles?select=token_hash,name'),
      rest<{ token_hash: string; day: string; messages: number }>(
        'daily_rows?select=token_hash,day,messages',
      ),
    ]);

    const byToken = new Map<string, DailyRow[]>();
    for (const row of rows) {
      const list = byToken.get(row.token_hash) ?? [];
      list.push({ day: row.day, messages: row.messages });
      byToken.set(row.token_hash, list);
    }

    return profiles.map((profile) => ({
      name: profile.name,
      rows: byToken.get(profile.token_hash) ?? [],
    }));
  }

  return {
    /**
     * Mint a token and claim a name.
     *
     * The insert is the uniqueness check: `name_folded` is a unique column, so
     * two concurrent enrolments proposing the same name cannot both succeed —
     * one gets a 409 and retries with a fresh proposal. Reading first and then
     * writing would let both through, which is exactly the race a random
     * assignment across a finite word list will eventually hit.
     *
     * **Only a 409 is retried.** Retrying every failure turns a permanent one
     * — a column that does not exist, a key that is not accepted — into twenty
     * sequential round trips and then a function timeout, which reaches the
     * user as "could not reach the leaderboard" and tells whoever is debugging
     * it nothing at all. Anything that is not a name conflict is raised on the
     * first attempt, and the handler answers 503 in under a second.
     */
    async enroll(assign) {
      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        const name = assign();
        const token = mintToken();

        try {
          await rest('profiles', {
            method: 'POST',
            body: JSON.stringify({
              token_hash: hashToken(token),
              name,
              name_folded: fold(name),
            }),
          });
        } catch (error) {
          if (error instanceof RestError && error.status === 409) continue;
          throw error;
        }

        return { token, name };
      }
      return null;
    },

    async profile(token) {
      const rows = await rest<{ name: string }>(
        `profiles?token_hash=eq.${encodeURIComponent(hashToken(token))}&select=name&limit=1`,
      );
      const row = rows[0];
      return row === undefined ? null : { name: row.name };
    },

    async saveDaily(token, row) {
      // `resolution=merge-duplicates` makes this an upsert on the composite
      // primary key, so a resubmission corrects the day rather than adding to
      // it or failing on a conflict.
      await rest('daily_rows', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({
          token_hash: hashToken(token),
          day: row.day,
          messages: row.messages,
        }),
      });
    },

    async board(period: Period, today: Day, size: number): Promise<Standing[]> {
      return rankBoard(await participants(), period, today, size);
    },

    async standing(name: string, period: Period, today: Day): Promise<Standing | null> {
      return standingFor(await participants(), name, period, today);
    },

    async forget(token) {
      const hash = encodeURIComponent(hashToken(token));
      // Rows first, then the profile they hang off. The other order would leave
      // rows keyed by a hash nothing points at any more — invisible to the
      // board, which reads through profiles, and impossible to delete later.
      await rest(`daily_rows?token_hash=eq.${hash}`, { method: 'DELETE' });
      await rest(`profiles?token_hash=eq.${hash}`, { method: 'DELETE' });
    },
  };
}

/**
 * A PostgREST response that was not ok.
 *
 * Carries the status because one caller has to tell a name conflict apart from
 * everything else: `enroll` retries a 409 and must not retry anything else. The
 * message names the status and the table and quotes no row data — PostgREST's
 * own body can carry the values that caused the failure.
 */
export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly table: string,
  ) {
    super(`supabase ${String(status)} on ${table}`);
    this.name = 'RestError';
  }
}

/** Profile type re-exported so callers need one import. */
export type { Profile };

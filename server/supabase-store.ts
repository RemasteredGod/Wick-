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
import { board as rankBoard, type Participant, type Standing } from '../leaderboard/ranking.js';
import { statsFrom } from './stats.js';
import type { Day, Period } from '../leaderboard/periods.js';
import type { DailyRow } from '../leaderboard/submission.js';
import type { BoardStore, Profile, ProfileStats } from './store.js';

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
      // Keep only PostgREST's machine code. Its message/detail can quote row
      // values, so neither is retained or surfaced by this adapter.
      let code: string | null = null;
      try {
        const errorBody = (await response.json()) as unknown;
        if (
          typeof errorBody === 'object' &&
          errorBody !== null &&
          'code' in errorBody &&
          typeof errorBody.code === 'string'
        ) {
          code = errorBody.code;
        }
      } catch {
        // A non-JSON upstream failure still propagates by status and endpoint.
      }
      throw new RestError(response.status, path.split('?')[0] ?? path, code);
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
   * Profiles and rows share the account email, so this is a straight join. Two
   * browsers on one account write to the same rows by construction — the
   * composite key is (email, day) — so there is nothing to reconcile here and
   * nobody can appear twice at half strength.
   */
  async function participants(): Promise<Participant[]> {
    const [profiles, rows] = await Promise.all([
      rest<{ email: string; name: string }>('profiles?select=email,name'),
      rest<{ email: string; day: string; messages: number }>(
        'daily_rows?select=email,day,messages',
      ),
    ]);

    const byEmail = new Map<string, DailyRow[]>();
    for (const row of rows) {
      const list = byEmail.get(row.email) ?? [];
      list.push({ day: row.day, messages: row.messages });
      byEmail.set(row.email, list);
    }

    return profiles.map((profile) => ({
      name: profile.name,
      rows: byEmail.get(profile.email) ?? [],
    }));
  }

  /** The account a bearer token belongs to, or null. */
  async function emailFor(token: string): Promise<string | null> {
    const rows = await rest<{ email: string }>(
      `tokens?token_hash=eq.${encodeURIComponent(hashToken(token))}&select=email&limit=1`,
    );
    return rows[0]?.email ?? null;
  }

  return {
    /**
     * Bind a browser to an account in one database transaction.
     *
     * The preliminary read exists only to preserve `BoardStore`'s promise that
     * `assign` is not consulted for an account already holding a profile. The
     * RPC repeats the lookup under a per-email transaction lock: that locked
     * lookup, optional profile insert, and hashed-token insert are the atomic
     * authority. A token failure therefore rolls a new profile back, while two
     * first-time callers converge on the exact name selected by the winner.
     *
     * The function maps only a candidate `name_folded` collision to `PT409`.
     * Token uniqueness failures and every unknown/server failure keep their own
     * code and are raised immediately rather than being mistaken for a name to
     * retry.
     */
    async enroll(email, assign) {
      const token = mintToken();
      const tokenHash = hashToken(token);
      const held = await rest<{ name: string }>(
        `profiles?email=eq.${encodeURIComponent(email)}&select=name&limit=1`,
      );
      const existing = held[0];

      const invoke = async (name: string | null): Promise<{ name: string; existing: boolean }> => {
        const rows = await rest<{ name: unknown; existing: unknown }>('rpc/enroll_profile', {
          method: 'POST',
          body: JSON.stringify({
            p_email: email,
            p_name: name,
            p_name_folded: name === null ? null : fold(name),
            p_token_hash: tokenHash,
          }),
        });
        const result = rows[0];
        if (
          rows.length !== 1 ||
          result === undefined ||
          typeof result.name !== 'string' ||
          result.name.length === 0 ||
          typeof result.existing !== 'boolean'
        ) {
          throw new Error('supabase invalid response on rpc/enroll_profile');
        }
        return { name: result.name, existing: result.existing };
      };

      if (existing !== undefined) {
        const result = await invoke(null);
        return { token, ...result };
      }

      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        const candidate = assign();
        try {
          const result = await invoke(candidate);
          return { token, ...result };
        } catch (error) {
          if (
            !(error instanceof RestError) ||
            error.status !== 409 ||
            error.code !== 'PT409'
          ) {
            throw error;
          }
        }
      }
      return null;
    },

    async profile(token) {
      const email = await emailFor(token);
      if (email === null) return null;

      const rows = await rest<{ name: string }>(
        `profiles?email=eq.${encodeURIComponent(email)}&select=name&limit=1`,
      );
      const row = rows[0];
      return row === undefined ? null : { name: row.name };
    },

    async saveDaily(token, row) {
      const email = await emailFor(token);
      // A token nobody holds writes nothing. The handler checks first and
      // answers 401, so reaching here means the profile was deleted between the
      // two calls — a race whose right outcome is silence, not a row keyed on
      // an account that no longer exists.
      if (email === null) return;

      // `resolution=merge-duplicates` makes this an upsert on the composite
      // primary key, so a resubmission corrects the day rather than adding to
      // it or failing on a conflict — and two browsers on one account converge
      // on a single row instead of double-counting the day.
      await rest('daily_rows', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify({ email, day: row.day, messages: row.messages }),
      });
    },

    async board(period: Period, today: Day, size: number): Promise<Standing[]> {
      return rankBoard(await participants(), period, today, size);
    },

    async stats(name: string, today: Day): Promise<ProfileStats | null> {
      // One read for the whole page. `standing()` used to answer one period at
      // a time, and every call reloaded and re-ranked every participant — a
      // profile view cost three of those, and still could not report a streak,
      // because a `Standing` has already summarised the days away.
      return statsFrom(await participants(), name, today);
    },

    async forget(token) {
      // One database function owns the account lookup and profile delete. The
      // profile's verified cascading foreign keys remove every browser token
      // and daily row in the same transaction, so a failed request cannot leave
      // a public profile half-deleted.
      //
      // The function deliberately returns false for an unknown hash. Leave is
      // idempotent: a repeated request, a stale browser, and an invalid token
      // all have the same safe outcome and reveal nothing about past profiles.
      await rest('rpc/forget_profile', {
        method: 'POST',
        body: JSON.stringify({ p_token_hash: hashToken(token) }),
      });
    },
  };
}

/**
 * A PostgREST response that was not ok.
 *
 * Carries the status and safe machine code because one caller has to tell a
 * candidate-name conflict apart from every other 409. `enroll` retries only
 * `PT409`; the message names the status and endpoint and quotes no row data —
 * PostgREST's own message/detail can carry the values that caused the failure.
 */
export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly table: string,
    readonly code: string | null = null,
  ) {
    super(`supabase ${String(status)} on ${table}`);
    this.name = 'RestError';
  }
}

/** Profile type re-exported so callers need one import. */
export type { Profile };

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

  /** Point a fresh token at an account. */
  async function bindToken(token: string, email: string): Promise<void> {
    await rest('tokens', {
      method: 'POST',
      body: JSON.stringify({ token_hash: hashToken(token), email }),
    });
  }

  return {
    /**
     * Bind a browser to the profile for an account, creating it if new.
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
    async enroll(email, assign) {
      const token = mintToken();

      // An account that already has a profile gets a second token pointing at
      // it, and keeps its name. This is the whole cross-browser story: the
      // primary key is the account, so there is nothing to look up but the
      // email and nothing for the user to do.
      const held = await rest<{ name: string }>(
        `profiles?email=eq.${encodeURIComponent(email)}&select=name&limit=1`,
      );
      const existing = held[0];

      if (existing !== undefined) {
        await bindToken(token, email);
        return { token, name: existing.name, existing: true };
      }

      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        const name = assign();

        try {
          await rest('profiles', {
            method: 'POST',
            body: JSON.stringify({ email, name, name_folded: fold(name) }),
          });
        } catch (error) {
          // A 409 is either the name being taken, or two browsers on one
          // account racing to create the profile. Re-reading settles both: if
          // the account now has a profile, the race is what happened and its
          // name is the answer.
          if (!(error instanceof RestError) || error.status !== 409) throw error;

          const raced = (
            await rest<{ name: string }>(
              `profiles?email=eq.${encodeURIComponent(email)}&select=name&limit=1`,
            )
          )[0];
          if (raced !== undefined) {
            await bindToken(token, email);
            return { token, name: raced.name, existing: true };
          }
          continue;
        }

        await bindToken(token, email);
        return { token, name, existing: false };
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
      const email = await emailFor(token);
      if (email === null) return;
      const key = encodeURIComponent(email);

      // Account-wide, not browser-wide. Leave says the profile is gone; a
      // version that unbound only the browser it was pressed in would leave the
      // public page up and another browser still publishing to it.
      //
      // Rows and tokens before the profile they hang off. The schema cascades,
      // but the explicit order does not depend on that constraint surviving a
      // database somebody rebuilt by hand.
      await rest(`daily_rows?email=eq.${key}`, { method: 'DELETE' });
      await rest(`tokens?email=eq.${key}`, { method: 'DELETE' });
      await rest(`profiles?email=eq.${key}`, { method: 'DELETE' });
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

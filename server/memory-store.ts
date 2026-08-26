/**
 * A `BoardStore` that lives in a process and dies with it.
 *
 * For tests and local development. It is a real implementation of the port, not
 * a stub: boards and standings run through the same `leaderboard/ranking`
 * functions the deployed board uses, and profile stats through the same
 * `server/stats`, so a bug in either shows up here rather than in production.
 *
 * **Not for deployment.** A serverless function gets a fresh module instance per
 * cold start, so this would appear to work in testing and silently forget
 * everything in production.
 */

import { board as rankBoard, type Participant, type Standing } from '../leaderboard/ranking.js';
import { statsFrom } from './stats.js';
import { fold } from '../leaderboard/names.js';
import type { Day, Period } from '../leaderboard/periods.js';
import type { DailyRow } from '../leaderboard/submission.js';
import type { BoardStore, Profile, ProfileStats } from './store.js';

interface Entry {
  profile: Profile;
  rows: DailyRow[];
}

/** How many names to propose before declaring the namespace full. See `enroll`. */
const NAME_ATTEMPTS = 20;

export interface MemoryStore extends BoardStore {
  /** Seed a participant, so a board has something to show. */
  seed(email: string, token: string, name: string, rows: DailyRow[]): void;
  /** Every token minted, oldest first. */
  readonly tokens: string[];
}

export function createMemoryStore(mintToken: () => string = defaultMint): MemoryStore {
  /** Profiles, by account email. The primary key, as in the schema. */
  const entries = new Map<string, Entry>();
  /** Bearer token to account email. One account can have many. */
  const bound = new Map<string, string>();
  const tokens: string[] = [];

  function participants(): Participant[] {
    return [...entries.values()].map((entry) => ({ name: entry.profile.name, rows: entry.rows }));
  }

  function taken(name: string): boolean {
    const folded = fold(name);
    for (const entry of entries.values()) {
      if (fold(entry.profile.name) === folded) return true;
    }
    return false;
  }

  function bind(token: string, email: string): void {
    bound.set(token, email);
    tokens.push(token);
  }

  return {
    tokens,

    seed(email, token, name, rows) {
      entries.set(email, { profile: { name }, rows });
      bind(token, email);
    },

    async enroll(email, assign) {
      const token = mintToken();

      // An account that already has a profile gets a second token pointing at
      // it, and keeps its name. That is the whole cross-browser story: the
      // primary key is the account, so there is nothing to look up but the
      // email and nothing for the user to do.
      const existing = entries.get(email);
      if (existing !== undefined) {
        bind(token, email);
        return { token, name: existing.profile.name, existing: true };
      }

      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        const name = assign();
        if (taken(name)) continue;

        entries.set(email, { profile: { name }, rows: [] });
        bind(token, email);
        return { token, name, existing: false };
      }
      return null;
    },

    async profile(token) {
      const email = bound.get(token);
      if (email === undefined) return null;
      return entries.get(email)?.profile ?? null;
    },

    async saveDaily(token, row) {
      const email = bound.get(token);
      if (email === undefined) return;

      const entry = entries.get(email);
      if (entry === undefined) return;

      // Upsert. A resubmission corrects the day rather than adding to it, and
      // two browsers on one account converge on a single row for the day
      // instead of double-counting it.
      const at = entry.rows.findIndex((existing) => existing.day === row.day);
      if (at === -1) entry.rows.push(row);
      else entry.rows[at] = row;
    },

    async board(period: Period, today: Day, size: number): Promise<Standing[]> {
      return rankBoard(participants(), period, today, size);
    },

    async stats(name: string, today: Day): Promise<ProfileStats | null> {
      return statsFrom(participants(), name, today);
    },

    async forget(token) {
      const email = bound.get(token);
      if (email === undefined) return;

      // Account-wide, not browser-wide: every token bound to the account goes,
      // not just the one that asked. Leave says the profile is gone, and a
      // version that unbound one browser would leave another still publishing.
      entries.delete(email);
      for (const [held, boundTo] of [...bound]) {
        if (boundTo !== email) continue;
        bound.delete(held);
        const at = tokens.indexOf(held);
        if (at !== -1) tokens.splice(at, 1);
      }
    },
  };
}

/** Sequential, so a test can predict what it will get. Never used in production. */
let counter = 0;
function defaultMint(): string {
  counter += 1;
  return `memory-token-${counter}`;
}

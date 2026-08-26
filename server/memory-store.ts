/**
 * A `BoardStore` that lives in a process and dies with it.
 *
 * For tests and local development. It is a real implementation of the port, not
 * a stub: boards and standings run through the same `leaderboard/ranking`
 * functions the deployed board uses, so a bug in the ranking shows up here
 * rather than in production.
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
  seed(token: string, name: string, rows: DailyRow[]): void;
  /** Every token minted, oldest first. */
  readonly tokens: string[];
}

export function createMemoryStore(mintToken: () => string = defaultMint): MemoryStore {
  const entries = new Map<string, Entry>();
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

  return {
    tokens,

    seed(token, name, rows) {
      entries.set(token, { profile: { name }, rows });
      tokens.push(token);
    },

    async enroll(assign) {
      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        const name = assign();
        if (taken(name)) continue;

        const token = mintToken();
        entries.set(token, { profile: { name }, rows: [] });
        tokens.push(token);
        return { token, name };
      }
      return null;
    },

    async profile(token) {
      return entries.get(token)?.profile ?? null;
    },

    async saveDaily(token, row) {
      const entry = entries.get(token);
      if (entry === undefined) return;

      // Upsert. A resubmission corrects the day rather than adding to it.
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
      entries.delete(token);
      const at = tokens.indexOf(token);
      if (at !== -1) tokens.splice(at, 1);
    },
  };
}

/** Sequential, so a test can predict what it will get. Never used in production. */
let counter = 0;
function defaultMint(): string {
  counter += 1;
  return `memory-token-${counter}`;
}

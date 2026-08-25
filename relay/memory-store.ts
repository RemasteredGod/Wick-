/**
 * A `RelayStore` that lives in a process and dies with it.
 *
 * For local development and tests. It exists so the bot can be talked to
 * before any database decision is finalised — ADR 0006 chose D1, the project is
 * looking at Supabase, and neither of those should block getting `/start` to
 * reply on a laptop.
 *
 * It is a real implementation of the port, not a stub: boards and standings run
 * through the same `leaderboard/ranking` functions the deployed relay will use,
 * so a bug in the ranking shows up here rather than in production.
 *
 * **Not for deployment.** A serverless function gets a fresh module instance per
 * cold start, so this would appear to work in testing and silently forget
 * everything in production.
 */

import { board as rankBoard, standingFor, type Participant, type Standing } from '../leaderboard/ranking';
import { fold } from '../leaderboard/names';
import type { Day, Period } from '../leaderboard/periods';
import type { DailyRow } from '../leaderboard/submission';
import type { Profile, RelayStore } from './store';

interface Entry {
  profile: Profile;
  rows: DailyRow[];
}

export interface MemoryStore extends RelayStore {
  /** Seed submissions, so `/me` and `/leaderboard` have something to show. */
  seed(chatId: number, name: string, rows: DailyRow[]): void;
  /** Mint a rename code without a payment, for trying the flow locally. */
  grantRenameCode(code: string): void;
  /** Codes handed out by `/start`, newest last. */
  readonly codes: { chatId: number; code: string; mintedAt: number }[];
}

export function createMemoryStore(): MemoryStore {
  const entries = new Map<number, Entry>();
  const renameCodes = new Set<string>();
  const codes: { chatId: number; code: string; mintedAt: number }[] = [];

  function participants(): Participant[] {
    return [...entries.values()].map((entry) => ({ name: entry.profile.name, rows: entry.rows }));
  }

  return {
    codes,

    seed(chatId, name, rows) {
      entries.set(chatId, { profile: { name, digest: false }, rows });
    },

    grantRenameCode(code) {
      renameCodes.add(code);
    },

    async saveCode(chatId, code, mintedAt) {
      codes.push({ chatId, code, mintedAt });
    },

    async profile(chatId) {
      return entries.get(chatId)?.profile ?? null;
    },

    async createProfile(chatId, name) {
      entries.set(chatId, { profile: { name, digest: false }, rows: [] });
    },

    async setName(chatId, name) {
      const entry = entries.get(chatId);
      if (entry) entry.profile.name = name;
    },

    async setDigest(chatId, on) {
      const entry = entries.get(chatId);
      if (entry) entry.profile.digest = on;
    },

    async isNameTaken(folded) {
      for (const entry of entries.values()) {
        if (fold(entry.profile.name) === folded) return true;
      }
      return false;
    },

    async redeemRenameCode(code) {
      return renameCodes.delete(code);
    },

    async board(period: Period, today: Day, size: number): Promise<Standing[]> {
      return rankBoard(participants(), period, today, size);
    },

    async standing(name: string, period: Period, today: Day): Promise<Standing | null> {
      return standingFor(participants(), name, period, today);
    },

    async deleteProfile(chatId) {
      entries.delete(chatId);
    },

    async forget(chatId) {
      entries.delete(chatId);
      for (let index = codes.length - 1; index >= 0; index -= 1) {
        if (codes[index]?.chatId === chatId) codes.splice(index, 1);
      }
    },
  };
}

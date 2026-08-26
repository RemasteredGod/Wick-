/**
 * What the bot does when someone types something.
 *
 * Parsing is pure and separate from handling, because parsing is where the
 * fiddly cases live — `/start@WickBot` in a group, a command with trailing
 * whitespace, `/digest` with no argument — and none of them should need a
 * database to test.
 *
 * Handling takes a `RelayStore` port, so every path below is exercised against
 * a fake rather than a deployment.
 *
 * Replies are plain strings with **no `parse_mode`**. See telegram.ts: the
 * relay does not interpret message text, and choosing a markup dialect for it
 * would be interpreting it.
 */

import { assignName, fold, validateName } from '../leaderboard/names.js';
import { rankedTotal } from '../leaderboard/ranking.js';
import { mintCode, normaliseCode } from './codes.js';
import type { Day } from '../leaderboard/periods.js';
import type { RelayStore } from './store.js';

/* ---- Parsing -------------------------------------------------------------- */

export type Command =
  | { kind: 'start' }
  | { kind: 'leaderboard' }
  | { kind: 'me' }
  | { kind: 'optin' }
  | { kind: 'optout' }
  | { kind: 'digest'; on: boolean | null }
  | { kind: 'rename'; code: string; name: string }
  | { kind: 'forget' }
  | { kind: 'help' };

/**
 * Read a command out of message text.
 *
 * Returns `help` for anything unrecognised, including ordinary conversation.
 * The bot is not a chat partner and should say so once rather than ignore
 * people — a bot that silently drops messages reads as broken.
 */
export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'help' };

  const [head = '', ...rest] = trimmed.split(/\s+/);

  // In groups Telegram delivers `/start@WickBot`. The suffix is addressing, not
  // an argument, and a bot that does not strip it appears dead in every group.
  const name = (head.split('@')[0] ?? '').slice(1).toLowerCase();

  switch (name) {
    case 'start':
      return { kind: 'start' };
    case 'leaderboard':
    case 'board':
      return { kind: 'leaderboard' };
    case 'me':
      return { kind: 'me' };
    case 'optin':
      return { kind: 'optin' };
    case 'optout':
      return { kind: 'optout' };
    case 'forget':
      return { kind: 'forget' };
    case 'digest': {
      const argument = (rest[0] ?? '').toLowerCase();
      if (argument === 'on') return { kind: 'digest', on: true };
      if (argument === 'off') return { kind: 'digest', on: false };
      // No argument, or an unreadable one: report state rather than guess.
      return { kind: 'digest', on: null };
    }
    case 'rename':
      return { kind: 'rename', code: normaliseCode(rest[0] ?? ''), name: (rest[1] ?? '').trim() };
    default:
      return { kind: 'help' };
  }
}

/* ---- Handling ------------------------------------------------------------- */

/** Everything a handler needs that is not the store. */
export interface Context {
  store: RelayStore;
  /** Epoch milliseconds. Passed in; nothing here reads a clock. */
  now: number;
  /** Today as a calendar day, for board queries. */
  today: Day;
  /** In [0, 1). A CSPRNG in production — see codes.ts. */
  random: () => number;
}

const HELP = [
  'Wick — Claude usage alerts and an opt-in leaderboard.',
  '',
  '/start — get a code to connect the extension',
  '/optin — join the leaderboard with an assigned name',
  '/me — your standing',
  '/leaderboard — this week, top 10',
  '/digest on|off — weekly summary, off by default',
  '/rename <code> <name> — spend a paid rename',
  '/optout — leave the leaderboard, keep alerts',
  '/forget — delete everything Wick holds about this chat',
].join('\n');

export async function handle(command: Command, chatId: number, context: Context): Promise<string> {
  const { store, now, today, random } = context;

  switch (command.kind) {
    case 'start': {
      const code = mintCode(random);
      await store.saveCode(chatId, code, now);
      return [
        `Your connect code is ${code}`,
        '',
        'Paste it into Wick within 10 minutes. It works once.',
        'You will never be asked for a bot token.',
      ].join('\n');
    }

    case 'optin': {
      const existing = await store.profile(chatId);
      if (existing !== null) {
        return `You are already on the leaderboard as ${existing.name}.`;
      }

      const name = await assignAvailableName(store, random);
      if (name === null) {
        return 'Could not assign a name just now. Try again in a moment.';
      }

      await store.createProfile(chatId, name);
      return [
        `You are on the leaderboard as ${name}.`,
        '',
        'The name was assigned, not chosen. Changing it costs $1 — /rename.',
        'Figures are self-reported by wick-cc on your own machine.',
      ].join('\n');
    }

    case 'me': {
      const profile = await store.profile(chatId);
      if (profile === null) return 'You are not on the leaderboard. /optin to join.';

      const standing = await store.standing(profile.name, 'week', today);
      if (standing === null) {
        return `${profile.name} — nothing submitted this week yet.`;
      }

      return [
        `${profile.name} — rank ${standing.rank} this week`,
        `${standing.ranked.toLocaleString()} tokens (input + output)`,
        `${standing.counters.cacheRead.toLocaleString()} cache reads, not counted`,
        `${standing.sessions} sessions`,
        '',
        'Self-reported. Not verified.',
      ].join('\n');
    }

    case 'leaderboard': {
      const rows = await store.board('week', today, 10);
      if (rows.length === 0) return 'No submissions this week yet.';

      const lines = rows.map(
        (row) => `${String(row.rank).padStart(2)}. ${row.name} — ${row.ranked.toLocaleString()}`,
      );
      return ['This week — top 10', '', ...lines, '', 'Self-reported. Not verified.'].join('\n');
    }

    case 'digest': {
      const profile = await store.profile(chatId);
      if (profile === null) return 'You are not on the leaderboard. /optin to join.';

      if (command.on === null) {
        return `Weekly digest is ${profile.digest ? 'on' : 'off'}. Use /digest on or /digest off.`;
      }

      await store.setDigest(chatId, command.on);
      return command.on
        ? 'Weekly digest on. It arrives Monday.'
        : 'Weekly digest off.';
    }

    case 'rename': {
      const profile = await store.profile(chatId);
      if (profile === null) return 'You are not on the leaderboard. /optin to join.';

      if (command.code === '' || command.name === '') {
        return 'Usage: /rename <code> <name>. A code comes from the $1 checkout.';
      }

      // Shape and reserved checks first: they are free, and they mean a bad
      // name never spends a code the user paid for.
      const shape = validateName(command.name, () => false);
      if (!shape.ok) return renameRefusal(shape.rejection);

      if (await store.isNameTaken(fold(shape.name))) return renameRefusal('taken');

      if (!(await store.redeemRenameCode(command.code))) {
        return 'That rename code is not valid, or has already been used.';
      }

      await store.setName(chatId, shape.name);
      return `You are now ${shape.name}.`;
    }

    case 'optout': {
      const profile = await store.profile(chatId);
      if (profile === null) return 'You are not on the leaderboard.';

      await store.deleteProfile(chatId);
      return [
        'Removed from the leaderboard. Every submitted row is deleted.',
        '',
        'Your alerts still work — this did not disconnect anything.',
      ].join('\n');
    }

    case 'forget': {
      await store.forget(chatId);
      return [
        'Deleted. Wick now holds nothing about this chat:',
        'connections, codes, leaderboard profile, and every submitted row.',
        '',
        'Alerts will stop. /start again to reconnect.',
      ].join('\n');
    }

    case 'help':
      return HELP;
  }
}

/* ---- Helpers -------------------------------------------------------------- */

/**
 * Draw an assigned name that is actually free.
 *
 * `assignName` takes a synchronous taken-check because it is pure; storage is
 * async. Rather than make the generator async — and drag a database into a
 * module that has no business knowing about one — candidates are drawn one at a
 * time here and checked against the store.
 */
async function assignAvailableName(
  store: RelayStore,
  random: () => number,
  attempts = 8,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = assignName(() => false, random, 1);
    if (candidate === null) continue;
    if (!(await store.isNameTaken(fold(candidate)))) return candidate;
  }
  return null;
}

/** Why a name was refused, in words a person can act on. */
function renameRefusal(rejection: string): string {
  switch (rejection) {
    case 'too-short':
      return 'That name is too short. Three characters or more.';
    case 'too-long':
      return 'That name is too long. Twenty-four characters or fewer.';
    case 'bad-characters':
      return 'Names use a-z, 0-9, hyphen and underscore only.';
    case 'bad-shape':
      return 'Names start with a letter, end with a letter or digit, and have no doubled separator.';
    case 'reserved':
      return 'That name is reserved.';
    case 'taken':
      return 'That name is taken, or too close to one that is.';
    default:
      return 'That name cannot be used.';
  }
}

/** Re-exported so the digest job and `/me` agree on what the figure means. */
export { rankedTotal };

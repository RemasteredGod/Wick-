/**
 * What the bot answers.
 *
 * Composition only — no `chrome.*`, no network, no clock of its own. Everything
 * comes in as arguments so each reply can be tested against a fixed snapshot.
 *
 * These replies are built from what the extension has already measured and
 * stored. Nothing here reaches for a number that is not in the snapshot or the
 * history: a limit Wick has not observed is reported as unknown, never as zero,
 * which is the same rule the panel and the alerts follow.
 */

import { project } from '~/core/projection';
import { allowanceWindow, sessionWindow } from '~/core/windows';
import { localDateKey } from '~/core/normalise';
import type { DailyRollup, LimitWindow, Snapshot } from '~/core/types';
import { thresholdMessage } from './alerts';

/** Everything the replies are built from. */
export interface Readings {
  snapshot: Snapshot | null;
  history: DailyRollup[];
  now: number;
}

export type Command = 'weekly' | 'daily' | 'help' | 'unknown';

/**
 * Read a command out of message text.
 *
 * Telegram appends `@botname` in groups, and a user's own bot can be added to
 * one. Stripping it costs a line and its absence makes the bot look dead.
 */
export function parseCommand(text: string): Command {
  const head = text.trim().split(/\s+/)[0] ?? '';
  if (!head.startsWith('/')) return 'unknown';

  const name = (head.split('@')[0] ?? '').slice(1).toLowerCase();

  switch (name) {
    case 'weekly':
    case 'week':
      return 'weekly';
    case 'daily':
    case 'today':
      return 'daily';
    case 'start':
    case 'help':
      return 'help';
    default:
      return 'unknown';
  }
}

/** The reply to one command. */
export function reply(command: Command, readings: Readings): string {
  switch (command) {
    case 'weekly':
      return weeklyReply(readings);
    case 'daily':
      return dailyReply(readings);
    case 'help':
      return HELP;
    case 'unknown':
      return `Not a command Wick knows.\n\n${HELP}`;
  }
}

/**
 * The help text, including the thing that will otherwise confuse everyone.
 *
 * Replies are produced by the extension on its polling alarm, so they are not
 * instant and they do not arrive at all while Chrome is closed. Saying so here
 * is the difference between a known limitation and a bot that looks broken.
 */
const HELP = [
  'Wick — your Claude usage, in Telegram.',
  '',
  '/weekly — weekly limit, pace, and when it runs out',
  '/daily — today so far',
  '/help — this',
  '',
  'Replies come from the Wick extension in your browser, not from a server.',
  'Chrome has to be open, and an answer can take a few minutes.',
].join('\n');

function weeklyReply({ snapshot, history, now }: Readings): string {
  const window = allowanceWindow(snapshot?.windows ?? []);

  if (window === null) {
    return 'No weekly reading yet. Open claude.ai and Wick will pick one up.';
  }
  if (window.utilization === null) {
    // The provider said the window exists but not how full it is. "Unknown" is
    // the honest word; inventing a percentage here would be the one thing
    // ADR 0001 rules out everywhere else.
    return `${window.shortLabel} — usage unknown. Wick has seen the window but not a number for it.`;
  }

  return thresholdMessage(window, project({ window, history, now }), now);
}

function dailyReply({ snapshot, history, now }: Readings): string {
  const today = localDateKey(now);
  const rollup = history.find((day) => day.date === today) ?? null;

  const lines: string[] = [];

  // A day with no rollup has not been written yet, which is different from a
  // day with nothing on it. Both are reported plainly rather than as "0".
  if (rollup === null) {
    lines.push('Nothing recorded today yet.');
  } else {
    const count = rollup.messageCount;
    lines.push(`Today: ${count} ${count === 1 ? 'message' : 'messages'}.`);
  }

  const current = [
    describe(sessionWindow(snapshot?.windows ?? [])),
    describe(allowanceWindow(snapshot?.windows ?? [])),
  ].filter((part): part is string => part !== null);

  if (current.length > 0) lines.push(current.join(' · '));

  return lines.join('\n');
}

/** "Session 31%", or `null` for a window with no number worth printing. */
function describe(window: LimitWindow | null): string | null {
  if (window === null || window.utilization === null) return null;
  return `${window.shortLabel} ${Math.round(window.utilization)}%`;
}

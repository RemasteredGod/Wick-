/**
 * The metric, and the order.
 *
 *     ranked = messages sent
 *
 * One number, summed over the period. ADR 0006 ranked `input + output` tokens
 * and carried two cache figures alongside without adding them in; that whole
 * apparatus existed because token counts arrive in four kinds of wildly
 * differing cost. A message count has no such structure — there is nothing to
 * weight, nothing to exclude, and nothing about the ranking that needs
 * explaining beside the figure. See `submission.ts` for why the metric moved.
 *
 * `days` rides along as the secondary column: how many distinct days the
 * participant submitted within the period. It is not part of the order. It is
 * there because "1,200 messages" reads differently over two days than over
 * seven, and the board should not make the reader guess which.
 *
 * Pure. `today` is passed in; nothing here reads a clock.
 */

import { inPeriod, type Day, type Period } from './periods.js';
import type { DailyRow } from './submission.js';

/** Everything one participant has submitted. Rows are unique by day. */
export interface Participant {
  /** The assigned or purchased name. Public, and the tie-break key. */
  name: string;
  rows: readonly DailyRow[];
}

/** One participant's standing on one board. */
export interface Standing {
  rank: number;
  name: string;
  /** Messages over the period. What the row is ordered by. */
  ranked: number;
  /** Distinct days submitted within the period. Displayed, never ordered by. */
  days: number;
  /** The most recent day this participant submitted within the period. */
  lastDay: Day | null;
}

/** How many rows a board publishes. ADR 0006. */
export const BOARD_SIZE = 100;

/**
 * The ranked figure for a row set.
 *
 * The single place the metric is defined. Nothing else in the codebase should
 * add these numbers together — if the definition ever changes it changes here,
 * and every board and profile moves with it.
 */
export function rankedTotal(rows: readonly DailyRow[]): number {
  return rows.reduce((sum, row) => sum + row.messages, 0);
}

/**
 * Fold one participant's rows into a standing for a period.
 *
 * `rank` is left at zero: a standing has no rank until it is placed against
 * everyone else, and returning a plausible-looking `1` from a function that
 * cannot know it would be a confident wrong number.
 */
export function summarise(participant: Participant, period: Period, today: Day): Standing {
  const within = participant.rows.filter((row) => inPeriod(row.day, period, today));

  let lastDay: Day | null = null;
  for (const row of within) {
    if (lastDay === null || row.day > lastDay) lastDay = row.day;
  }

  return {
    rank: 0,
    name: participant.name,
    ranked: rankedTotal(within),
    days: new Set(within.map((row) => row.day)).size,
    lastDay,
  };
}

/**
 * Order standings and assign ranks.
 *
 * **Ties share a rank, and the next distinct figure skips** — 1, 2, 2, 4 rather
 * than 1, 2, 2, 3. Two people who did identical work are not separated by an
 * accident of iteration order, and the fourth is not told they came third.
 *
 * The tie-break is the name, ascending. It has to be something, it has to be
 * stable across requests so a reload does not shuffle rows, and it has to be
 * public — ordering by first-seen or by internal id would leak a fact about
 * accounts that the board does not otherwise publish.
 */
export function place(standings: readonly Standing[]): Standing[] {
  const ordered = [...standings].sort(compare);

  let rank = 0;
  let previous: number | null = null;

  return ordered.map((standing, index) => {
    if (previous === null || standing.ranked !== previous) {
      rank = index + 1;
      previous = standing.ranked;
    }
    return { ...standing, rank };
  });
}

function compare(a: Standing, b: Standing): number {
  if (a.ranked !== b.ranked) return b.ranked - a.ranked;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * One whole board.
 *
 * Participants with nothing in the period are dropped rather than published
 * with a zero. A zero here means "submitted nothing this week", which is not a
 * standing and should not occupy a row somebody else earned.
 */
export function board(
  participants: readonly Participant[],
  period: Period,
  today: Day,
  size: number = BOARD_SIZE,
): Standing[] {
  const summaries = participants
    .map((participant) => summarise(participant, period, today))
    .filter((standing) => standing.ranked > 0);

  return place(summaries).slice(0, size);
}

/**
 * Where one name sits on a board, counting everyone rather than the top slice.
 *
 * The profile page (ADR 0008) shows a rank for participants far below the
 * hundredth row, so it cannot read one off `board`. Returns `null` for a name
 * that submitted nothing in the period.
 */
export function standingFor(
  participants: readonly Participant[],
  name: string,
  period: Period,
  today: Day,
): Standing | null {
  const all = place(
    participants
      .map((participant) => summarise(participant, period, today))
      .filter((standing) => standing.ranked > 0),
  );

  return all.find((standing) => standing.name === name) ?? null;
}

/**
 * The longest run of consecutive submitted days ending at the most recent one.
 *
 * Computed from days already submitted, so it says nothing the board does not
 * already publish. Note what it is *not*: it is not "days without hitting a
 * limit", which would require the server to retain a usage history it never
 * receives.
 */
export function streak(participant: Participant): number {
  const days = [...new Set(participant.rows.map((row) => row.day))].sort();
  const last = days[days.length - 1];
  if (last === undefined) return 0;

  let run = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    const day = days[index];
    const before = days[index - 1];
    if (day === undefined || before === undefined) break;
    if (dayBefore(day) !== before) break;
    run += 1;
  }

  return run;
}

function dayBefore(day: Day): Day {
  const at = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)) - 1,
  );
  const date = new Date(at);
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

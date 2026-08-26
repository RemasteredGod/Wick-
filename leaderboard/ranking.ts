/**
 * The metric, and the order.
 *
 * "Total tokens" is the obvious ranking and the wrong one. Cache tokens are far
 * cheaper than input tokens, so a raw sum ranks whoever has the most
 * cache-heavy workflow above whoever did the most work. ADR 0006 settles it:
 *
 *     ranked = input + output
 *
 * with **both** cache figures carried through every calculation and added to
 * none of them. They are displayed beside the figure so the ranking is legible
 * rather than a mystery number, and that is the only thing they are for. There
 * is deliberately no option, flag or parameter in this file that folds them in.
 *
 * `plan.md` §4 recommends counting `cache_creation` into the score. ADR 0006 is
 * the accepted decision and excludes it. Where the two disagree, the ADR wins.
 *
 * Pure. `today` is passed in; nothing here reads a clock.
 */

import { inPeriod, type Day, type Period } from './periods.js';
import { addCounters, emptyCounters, type Counters, type DailyRow } from './submission.js';

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
  /** `input + output`. What the row is ordered by; no cache figure is in it. */
  ranked: number;
  counters: Counters;
  sessions: number;
  /** The most recent day this participant submitted within the period. */
  lastDay: Day | null;
}

/** How many rows a board publishes. ADR 0006. */
export const BOARD_SIZE = 100;

/**
 * The ranked figure for a counter set.
 *
 * The single place the metric is defined. Nothing else in the codebase should
 * add these numbers together — if the definition ever changes it changes here,
 * and every board, profile and share image moves with it.
 */
export function rankedTotal(counters: Counters): number {
  return counters.input + counters.output;
}

/**
 * Fold one participant's rows into a standing for a period.
 *
 * `rank` is left at zero: a standing has no rank until it is placed against
 * everyone else, and returning a plausible-looking `1` from a function that
 * cannot know it would be a confident wrong number.
 */
export function summarise(participant: Participant, period: Period, today: Day): Standing {
  let counters = emptyCounters();
  let sessions = 0;
  let lastDay: Day | null = null;

  for (const row of participant.rows) {
    if (!inPeriod(row.day, period, today)) continue;

    counters = addCounters(counters, row.counters);
    sessions += row.sessions;
    if (lastDay === null || row.day > lastDay) lastDay = row.day;
  }

  return { rank: 0, name: participant.name, ranked: rankedTotal(counters), counters, sessions, lastDay };
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
 * limit", which would require the relay to retain the usage history ADR 0003
 * promises it does not keep.
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

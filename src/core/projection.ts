/**
 * Burn-rate projection — when the user runs out.
 *
 * This is the product. Every other layer exists to feed it or display it, and
 * it is the only part that has to be genuinely correct: a percentage that is
 * slightly stale is a small bug, but "you run out Tuesday" when the real answer
 * is Thursday is the whole extension being wrong.
 *
 * Accordingly: pure functions only. No `chrome.*`, no I/O, no clock reads that
 * are not passed in. `now` is a parameter so that every branch is reachable
 * from a test without faking time.
 *
 * **Status: M1 scaffold.** The insufficient-history path below is implemented
 * and final. The pace estimate itself is M4 — see `project()`.
 */

import { localDateKey } from './normalise';
import type { DailyRollup, LimitWindow, Projection, ProjectionConfidence } from './types';

/**
 * Days of history below which no projection is attempted.
 *
 * Two points define a line through any noise at all, so two days of history
 * will confidently project nonsense. Three is the minimum at which a claim of
 * "your current pace" means anything, and even then it is reported as low
 * confidence.
 */
export const MIN_HISTORY_DAYS = 3;

/** Days of history at which the estimate is treated as fully weighted. */
export const FULL_CONFIDENCE_DAYS = 7;

export interface ProjectionInput {
  /** The window being projected. */
  window: LimitWindow;
  /**
   * Daily rollups, any order, possibly with gaps. Days on which the user did
   * not touch Claude are legitimately absent and must not be read as zeros —
   * an absent day is missing evidence, not evidence of nothing.
   */
  history: DailyRollup[];
  /** Epoch milliseconds. Injected rather than read, so tests can control it. */
  now: number;
}

/**
 * Project when `window` will be exhausted.
 *
 * Returns `exhaustionEstimate: null` whenever there is no honest answer —
 * because there is not enough history, because the window is not moving, or
 * because at the current pace it resets before it runs out. `reason` says
 * which, and the interface shows it.
 */
export function project(input: ProjectionInput): Projection {
  const { window, history, now } = input;

  const relevant = usableHistory(window.key, history, now);

  if (relevant.length < MIN_HISTORY_DAYS) {
    const have = relevant.length;
    return {
      exhaustionEstimate: null,
      confidence: 'none',
      pace: null,
      reason:
        have === 0
          ? 'No history yet'
          : `Only ${have} ${have === 1 ? 'day' : 'days'} of history — need ${MIN_HISTORY_DAYS}`,
    };
  }

  // M4 implements the estimate itself: pace from the weighted daily deltas,
  // the fraction of the current window already elapsed, and the reset boundary.
  // Until then Wick says it does not know rather than guessing, which is the
  // same rule the parsing layer follows for missing fields.
  return {
    exhaustionEstimate: null,
    confidence: 'none',
    pace: null,
    reason: 'Projection not implemented yet',
  };
}

/**
 * Rollups that carry a reading for this window and are old enough to be
 * complete.
 *
 * Today is excluded: it is partially elapsed, so treating it as a full day
 * understates pace every morning and overstates it every evening. The current
 * window's own utilization covers the present; history covers the past.
 */
export function usableHistory(
  windowKey: string,
  history: DailyRollup[],
  now: number,
): DailyRollup[] {
  const today = localDateKey(now);
  return history
    .filter((day) => day.date !== today && typeof day.windows[windowKey] === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * How much to trust an estimate built from `days` days of history.
 *
 * Exported so the interface and the projection agree on the wording rather than
 * each deciding what "enough" means.
 */
export function confidenceFor(days: number): ProjectionConfidence {
  if (days < MIN_HISTORY_DAYS) return 'none';
  if (days < FULL_CONFIDENCE_DAYS) return 'low';
  return days >= FULL_CONFIDENCE_DAYS * 2 ? 'high' : 'medium';
}


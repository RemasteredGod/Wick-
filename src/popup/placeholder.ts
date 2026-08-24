/**
 * Placeholder data for the M1 scaffold.
 *
 * The numbers are the design archive's own — Session 68%, Weekly 82%, the
 * Tuesday-evening forecast, 41 today against an average of 28 — so that a build
 * can be held up against the mockup and compared honestly.
 *
 * The dates are computed from `now` rather than hardcoded, so the interface
 * renders sensibly whenever it is opened while still producing the archive's
 * exact wording: a weekly window resetting Thursday at 09:00, exhausted the
 * Tuesday evening two days before.
 *
 * **This module disappears in M3**, when the popup starts reading the store.
 * Nothing here should acquire a second caller in the meantime.
 */

import type { DailyRollup, LimitWindow, Projection } from '~/core/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Thursday. `Date.getDay()` counts from Sunday. */
const WEEKLY_RESET_DAY = 4;
const WEEKLY_RESET_HOUR = 9;
const EXHAUSTION_HOUR = 19;

export function placeholderWindows(now: number): LimitWindow[] {
  return [
    {
      key: '5h',
      label: 'Session · 5 hr',
      shortLabel: 'Session',
      utilization: 68,
      status: 'ok',
      // "Resets in 1 hr 42 min", as the archive has it.
      resetsAt: now + HOUR_MS + 42 * 60_000,
      active: true,
    },
    {
      key: '7d',
      label: 'Weekly',
      shortLabel: 'Weekly',
      utilization: 82,
      status: 'approaching',
      resetsAt: nextWeeklyReset(now),
      active: true,
    },
  ];
}

export function placeholderProjection(now: number): Projection {
  const reset = nextWeeklyReset(now);
  const exhaustion = new Date(reset - 2 * DAY_MS);
  exhaustion.setHours(EXHAUSTION_HOUR, 0, 0, 0);

  return {
    exhaustionEstimate: exhaustion.getTime(),
    confidence: 'medium',
    pace: 11.7,
    reason: 'Placeholder',
  };
}

/**
 * Seven days of peaks, matching the archive's sparkline.
 *
 * The final value is 82 rather than the archive's full-height bar, so that
 * today's column agrees with the weekly meter above it.
 */
const PEAKS = [38, 52, 24, 66, 44, 74, 82];

export function placeholderHistory(now: number): DailyRollup[] {
  return PEAKS.map((peak, index) => {
    const day = new Date(now - (PEAKS.length - 1 - index) * DAY_MS);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    return {
      date: `${day.getFullYear()}-${month}-${date}`,
      windows: { '7d': peak, '5h': Math.round(peak * 0.83) },
      messageCount: Math.round(peak * 0.5),
    };
  });
}

export const PLACEHOLDER_STATS = {
  today: 41,
  averagePerDay: 28,
  peakHour: '14:00',
} as const;

export const PLACEHOLDER_PLAN = 'Max 5×';

export const PLACEHOLDER_TELEGRAM = {
  connected: true,
  threshold: 80,
  alsoOnReset: true,
} as const;

/** The next Thursday at 09:00 local, strictly after `now`. */
function nextWeeklyReset(now: number): number {
  const at = new Date(now);
  at.setHours(WEEKLY_RESET_HOUR, 0, 0, 0);

  let ahead = (WEEKLY_RESET_DAY - at.getDay() + 7) % 7;
  if (ahead === 0 && at.getTime() <= now) ahead = 7;

  at.setDate(at.getDate() + ahead);
  return at.getTime();
}

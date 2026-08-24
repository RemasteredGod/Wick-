/**
 * Pure aggregations over daily rollups.
 *
 * Everything the panel's stat row needs, computed from history alone. No I/O,
 * no `chrome.*`, `now` injected — same rules as projection.ts.
 *
 * All three return `null` rather than `0` when the record has nothing to say.
 * The interface renders `null` as "unknown", and a confident wrong number is
 * worse than an honest gap.
 */

import { localDateKey } from './normalise';
import type { DailyRollup } from './types';

/** Messages sent today. `null` when today has no record yet. */
export function messagesToday(history: DailyRollup[], now: number): number | null {
  const today = localDateKey(now);
  const rollup = history.find((day) => day.date === today);
  if (rollup === undefined) return null;

  // A rollup that exists but counts zero is not a gap: Wick was watching and
  // saw nothing sent. That is a real zero and worth showing as one.
  return Number.isFinite(rollup.messageCount) ? rollup.messageCount : null;
}

/**
 * Mean messages per day over complete days. `null` when there are none.
 *
 * Today is excluded because it is partially elapsed — counting a morning as a
 * full day would drag the mean down every morning and let it drift back up
 * every evening, so the number would move without the user's habit changing.
 */
export function averageMessagesPerDay(history: DailyRollup[], now: number): number | null {
  const today = localDateKey(now);
  const complete = history.filter(
    (day) => day.date !== today && Number.isFinite(day.messageCount),
  );
  if (complete.length === 0) return null;

  const total = complete.reduce((sum, day) => sum + day.messageCount, 0);
  // One decimal place: the panel shows this as a rate, and float noise like
  // 18.299999999999997 would reach the display otherwise.
  return Math.round((total / complete.length) * 10) / 10;
}

/**
 * Busiest local hour across the record, as 0-23. `null` when nothing is logged.
 *
 * Today counts here, unlike in the daily mean. An hour histogram is not
 * distorted by the day being incomplete — the hours that have happened are as
 * true as any other day's — and discarding them would throw away the most
 * recent evidence of when the user works. Ties go to the earlier hour.
 */
export function peakHour(history: DailyRollup[]): number | null {
  const totals = new Array<number>(24).fill(0);
  let logged = 0;

  for (const day of history) {
    const hours = day.hourlyMessages;
    if (!Array.isArray(hours)) continue;

    // Rollups written before hourly counts existed, or truncated ones, are
    // read as far as they go rather than skipped.
    const span = Math.min(24, hours.length);
    for (let hour = 0; hour < span; hour += 1) {
      const count = hours[hour];
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
      totals[hour] = (totals[hour] ?? 0) + count;
      logged += count;
    }
  }

  if (logged === 0) return null;

  let peak = 0;
  for (let hour = 1; hour < 24; hour += 1) {
    if ((totals[hour] ?? 0) > (totals[peak] ?? 0)) peak = hour;
  }
  return peak;
}

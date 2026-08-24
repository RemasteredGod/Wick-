/**
 * Pure aggregations over daily rollups.
 *
 * Everything the panel's stat row needs, computed from history alone. No I/O,
 * no `chrome.*`, `now` injected — same rules as projection.ts.
 */

import type { DailyRollup } from './types';

/** Messages sent today. `null` when today has no record yet. */
export function messagesToday(_history: DailyRollup[], _now: number): number | null {
  return null; // M4.
}

/** Mean messages per day over complete days. `null` when there are none. */
export function averageMessagesPerDay(_history: DailyRollup[], _now: number): number | null {
  return null; // M4.
}

/** Busiest local hour across the record, as 0-23. `null` when nothing is logged. */
export function peakHour(_history: DailyRollup[]): number | null {
  return null; // M4.
}

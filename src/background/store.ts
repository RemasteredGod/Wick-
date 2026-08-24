/**
 * Local persistence. `chrome.storage.local`, two shapes, nothing else.
 *
 * The store is the seam between collection and display: the collector writes,
 * the interface reads, and neither knows about the other. Presentation never
 * fetches.
 *
 * History is append-only and cannot be backfilled. Every day Wick runs without
 * writing a rollup is a day of evidence permanently lost, which is why this
 * module exists and works before anything reads from it.
 */

import { localDateKey } from '~/core/normalise';
import type { DailyRollup, Snapshot } from '~/core/types';

const KEY_SNAPSHOT = 'wick:current';
const KEY_HISTORY = 'wick:history';

/**
 * Days of history retained.
 *
 * Long enough to see a monthly shape, short enough that the whole record stays
 * small. Rollups are a few dozen bytes each, so this is generous.
 */
export const HISTORY_RETENTION_DAYS = 90;

/** The latest reading, or `null` if nothing has been collected yet. */
export async function readSnapshot(): Promise<Snapshot | null> {
  const stored = await chrome.storage.local.get(KEY_SNAPSHOT);
  const value = stored[KEY_SNAPSHOT];
  return isSnapshot(value) ? value : null;
}

/**
 * Replace the current snapshot.
 *
 * Callers decide precedence before calling: an authoritative `usage` reading
 * wins over an optimistic `stream` one unconditionally, so a stream reading
 * that arrives after a fetch must not be written over it.
 */
export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  await chrome.storage.local.set({ [KEY_SNAPSHOT]: snapshot });
}

/** Every rollup held, oldest first. */
export async function readHistory(): Promise<DailyRollup[]> {
  const stored = await chrome.storage.local.get(KEY_HISTORY);
  const value = stored[KEY_HISTORY];
  if (!Array.isArray(value)) return [];
  return value.filter(isRollup).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fold a reading into today's rollup.
 *
 * Peak rather than latest, per window: a window that resets mid-day would
 * otherwise erase its own evidence, and the peak is what the projection needs.
 * Windows absent from `utilizations` are left untouched rather than zeroed —
 * missing evidence is not evidence of nothing.
 */
export async function recordReading(
  utilizations: Record<string, number>,
  at: number,
): Promise<DailyRollup> {
  const date = localDateKey(at);
  const history = await readHistory();
  const existing = history.find((day) => day.date === date);

  const merged: DailyRollup = existing
    ? { ...existing, windows: { ...existing.windows } }
    : { date, windows: {}, messageCount: 0 };

  for (const [key, value] of Object.entries(utilizations)) {
    if (!Number.isFinite(value)) continue;
    const previous = merged.windows[key];
    merged.windows[key] = previous === undefined ? value : Math.max(previous, value);
  }

  await writeRollup(merged, history);
  return merged;
}

/** Increment today's message count. */
export async function recordMessage(at: number): Promise<void> {
  const date = localDateKey(at);
  const history = await readHistory();
  const existing = history.find((day) => day.date === date);

  const merged: DailyRollup = existing
    ? { ...existing, messageCount: existing.messageCount + 1 }
    : { date, windows: {}, messageCount: 1 };

  await writeRollup(merged, history);
}

async function writeRollup(rollup: DailyRollup, history: DailyRollup[]): Promise<void> {
  const others = history.filter((day) => day.date !== rollup.date);
  const next = [...others, rollup]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_RETENTION_DAYS);

  await chrome.storage.local.set({ [KEY_HISTORY]: next });
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Snapshot>;
  return typeof v.providerId === 'string' && Array.isArray(v.windows);
}

function isRollup(value: unknown): value is DailyRollup {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<DailyRollup>;
  return typeof v.date === 'string' && typeof v.windows === 'object' && v.windows !== null;
}

/**
 * Local persistence. `chrome.storage.local`, and nothing else.
 *
 * The store is the seam between collection and display: the collector writes,
 * the interface reads, and neither knows about the other. Presentation never
 * fetches.
 *
 * It is also the seam between the background modules. The icon renderer and the
 * alert dispatcher both react to snapshots, and both do it by subscribing to
 * storage changes rather than by being called — so none of the three has to
 * import the others, and adding a fourth consumer costs nothing.
 *
 * History is append-only and cannot be backfilled. Every day Wick runs without
 * writing a rollup is a day of evidence permanently lost, which is why this
 * module worked before anything read from it.
 */

import { localDateKey } from '~/core/normalise';
import {
  DEFAULT_SETTINGS,
  type AlertRecord,
  type CollectorStatus,
  type DailyRollup,
  type Settings,
  type Snapshot,
  type WickState,
} from '~/core/types';

/** Storage keys. Exported so subscribers can filter `chrome.storage.onChanged`. */
export const KEYS = {
  snapshot: 'wick:current',
  history: 'wick:history',
  settings: 'wick:settings',
  status: 'wick:status',
  alerts: 'wick:alerts',
} as const;

/**
 * Days of history retained.
 *
 * Long enough to show a monthly shape, short enough that the whole record stays
 * small. A rollup is a few dozen bytes, so this is generous.
 */
export const HISTORY_RETENTION_DAYS = 90;

/** Alert records retained. Only recent ones matter, for de-duplication. */
const ALERT_RETENTION = 50;

/* ---- Snapshot ------------------------------------------------------------ */

export async function readSnapshot(): Promise<Snapshot | null> {
  const stored = await chrome.storage.local.get(KEYS.snapshot);
  const value = stored[KEYS.snapshot];
  return isSnapshot(value) ? value : null;
}

/**
 * Replace the current snapshot.
 *
 * Precedence is decided here rather than at each call site: an authoritative
 * `usage` reading always wins, and an optimistic `stream` reading is refused if
 * it would overwrite a fetch that already happened. Otherwise a stream event
 * arriving a moment after a poll would drag the display backwards.
 */
export async function writeSnapshot(snapshot: Snapshot): Promise<boolean> {
  if (snapshot.source !== 'usage') {
    const existing = await readSnapshot();
    if (existing?.source === 'usage' && existing.fetchedAt >= snapshot.fetchedAt) return false;
  }
  await chrome.storage.local.set({ [KEYS.snapshot]: snapshot });
  return true;
}

/* ---- History ------------------------------------------------------------- */

/** Every rollup held, oldest first. */
export async function readHistory(): Promise<DailyRollup[]> {
  const stored = await chrome.storage.local.get(KEYS.history);
  const value = stored[KEYS.history];
  if (!Array.isArray(value)) return [];
  return value.filter(isRollup).map(withHourly).sort((a, b) => a.date.localeCompare(b.date));
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
  const merged = todayRollup(history, date);

  for (const [key, value] of Object.entries(utilizations)) {
    if (!Number.isFinite(value)) continue;
    const previous = merged.windows[key];
    merged.windows[key] = previous === undefined ? value : Math.max(previous, value);
  }

  await writeRollup(merged, history);
  return merged;
}

/** Increment today's message count, and the hour it happened in. */
export async function recordMessage(at: number): Promise<void> {
  const date = localDateKey(at);
  const history = await readHistory();
  const merged = todayRollup(history, date);

  merged.messageCount += 1;
  const hour = new Date(at).getHours();
  merged.hourlyMessages[hour] = (merged.hourlyMessages[hour] ?? 0) + 1;

  await writeRollup(merged, history);
}

function todayRollup(history: DailyRollup[], date: string): DailyRollup {
  const existing = history.find((day) => day.date === date);
  return existing
    ? { ...existing, windows: { ...existing.windows }, hourlyMessages: [...existing.hourlyMessages] }
    : { date, windows: {}, messageCount: 0, hourlyMessages: emptyHours() };
}

async function writeRollup(rollup: DailyRollup, history: DailyRollup[]): Promise<void> {
  const others = history.filter((day) => day.date !== rollup.date);
  const next = [...others, rollup]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_RETENTION_DAYS);

  await chrome.storage.local.set({ [KEYS.history]: next });
}

/* ---- Settings ------------------------------------------------------------ */

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEYS.settings);
  const value = stored[KEYS.settings];
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };

  // Merged field by field rather than spread wholesale, so a settings object
  // written by an older version gains new defaults instead of leaving holes.
  const partial = value as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    display: { ...DEFAULT_SETTINGS.display, ...(partial.display ?? {}) },
  };
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

/* ---- Collector status ---------------------------------------------------- */

export async function readStatus(): Promise<CollectorStatus> {
  const stored = await chrome.storage.local.get(KEYS.status);
  const value = stored[KEYS.status];
  if (typeof value !== 'object' || value === null) return { kind: 'never-run' };
  return value as CollectorStatus;
}

export async function writeStatus(status: CollectorStatus): Promise<void> {
  await chrome.storage.local.set({ [KEYS.status]: status });
}

/* ---- Alert log ----------------------------------------------------------- */

export async function readAlerts(): Promise<AlertRecord[]> {
  const stored = await chrome.storage.local.get(KEYS.alerts);
  const value = stored[KEYS.alerts];
  return Array.isArray(value) ? (value as AlertRecord[]) : [];
}

export async function recordAlert(alert: AlertRecord): Promise<void> {
  const next = [...(await readAlerts()), alert].slice(-ALERT_RETENTION);
  await chrome.storage.local.set({ [KEYS.alerts]: next });
}

/* ---- Assembled state ----------------------------------------------------- */

/** Everything the interface needs, in one read. */
export async function readState(): Promise<WickState> {
  const [snapshot, history, settings, status] = await Promise.all([
    readSnapshot(),
    readHistory(),
    readSettings(),
    readStatus(),
  ]);
  return { snapshot, history, settings, status };
}

/* ---- Guards -------------------------------------------------------------- */

function emptyHours(): number[] {
  return new Array<number>(24).fill(0);
}

/** Rollups written before hourly counts existed are missing the array. */
function withHourly(rollup: DailyRollup): DailyRollup {
  return Array.isArray(rollup.hourlyMessages) && rollup.hourlyMessages.length === 24
    ? rollup
    : { ...rollup, hourlyMessages: emptyHours() };
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

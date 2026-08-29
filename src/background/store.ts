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
import { mergeReading, type Reading } from '~/core/windows';
import {
  DEFAULT_SETTINGS,
  type AlertRecord,
  type CollectorStatus,
  type DailyRollup,
  type LeaderboardDailyEntry,
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
  account: 'wick:account',
  accountEmail: 'wick:account-email',
  boardLedger: 'wick:board-ledger',
} as const;

/**
 * Serialise a read-modify-write against storage.
 *
 * `chrome.storage.local` has no compare-and-swap and no transaction. Two
 * overlapping folds into the same rollup — a poll and a message sent in the
 * same second, which is the normal case, not the rare one — both read the same
 * array and the second write silently discards the first. History is
 * append-only and cannot be reconstructed, so a lost increment is lost for good.
 *
 * One worker means one queue is enough. The popup reads but never writes
 * history, so there is no second writer to coordinate with.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(work, work);
  // The queue must survive a failed write, or one rejection strands every
  // update behind it for the life of the worker.
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Days of history retained.
 *
 * Long enough to show a monthly shape, short enough that the whole record stays
 * small. A rollup is a few dozen bytes, so this is generous.
 */
export const HISTORY_RETENTION_DAYS = 90;

/** Local calendar days retained in each email's publication ledger. */
export const LEADERBOARD_RETENTION_DAYS = 90;

/** Alert records retained. Only recent ones matter, for de-duplication. */
const ALERT_RETENTION = 50;

/* ---- Snapshot ------------------------------------------------------------ */

export async function readSnapshot(): Promise<Snapshot | null> {
  const stored = await chrome.storage.local.get(KEYS.snapshot);
  const value = stored[KEYS.snapshot];
  if (!isSnapshot(value)) return null;
  // Snapshots written before accounts were tracked have no tag. They belong to
  // whoever is signed in — there was only one account writing them.
  return { ...value, accountId: value.accountId ?? null };
}

/**
 * Fold a reading into the stored snapshot.
 *
 * Precedence and merging live in `src/core/windows.ts`, where they are pure and
 * testable; this is the part that touches storage. Returns the snapshot that is
 * now stored, or `null` when the reading changed nothing and no write happened.
 *
 * Serialised with the history writes, because a poll folds a reading and then
 * folds the same numbers into today's rollup, and a stream event does both at
 * the same time from a different task.
 */
export async function writeSnapshot(reading: Reading, now = Date.now()): Promise<Snapshot | null> {
  return serialised(async () => {
    const merged = mergeReading(await readSnapshot(), reading, now);
    if (merged === null) return null;
    await chrome.storage.local.set({ [KEYS.snapshot]: merged });
    return merged;
  });
}

/**
 * Forget the current reading, keeping history.
 *
 * Called when the account goes away — signed out, or the organisation cookie
 * cleared. The numbers on screen belong to a session that no longer exists, and
 * leaving them there means the panel confidently describes someone who is not
 * signed in. History stays: it is the user's own record, it is append-only, and
 * signing out is not a reason to destroy it.
 */
export async function clearSnapshot(): Promise<void> {
  await chrome.storage.local.remove(KEYS.snapshot);
}

/* ---- Account ------------------------------------------------------------- */

/**
 * The account the stored readings and rollups belong to.
 *
 * Held separately from the snapshot because the interface needs it to pick the
 * right history even when there is no snapshot yet, and because the collector
 * learns it before it learns anything else.
 */
export async function readAccountId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(KEYS.account);
  const value = stored[KEYS.account];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The Claude account signed in, as the content script last saw it.
 *
 * Held separately from `Settings` because it is an observation rather than a
 * preference: nothing on a settings screen sets it, and the user cannot change
 * it except by signing into a different account. `Settings.boardEmail` is the
 * different thing — the account the *board token* belongs to — and comparing
 * the two is how `board.ts` notices a switch.
 *
 * `null` before any claude.ai tab has been open, and for a signed-out session.
 */
export async function readAccountEmail(): Promise<string | null> {
  try {
    const stored = (await chrome.storage.local.get(KEYS.accountEmail))[KEYS.accountEmail];
    return typeof stored === 'string' ? normaliseAccountEmail(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Normalize an account observation without treating it as proof of identity.
 *
 * This only keeps local partitions stable across case/whitespace differences;
 * the sidebar observation remains self-reported and is never a credential.
 */
export function normaliseAccountEmail(value: string): string | null {
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0 || normalised.length > 320) return null;
  if (/[\u0000-\u0020\u007f]/.test(normalised)) return null;
  const at = normalised.indexOf('@');
  if (at <= 0 || at !== normalised.lastIndexOf('@') || at === normalised.length - 1) return null;
  return normalised;
}

/** Record a nullable observation. Never throws; unknown is a durable state. */
export async function writeAccountEmail(email: string | null): Promise<void> {
  try {
    const normalised = email === null ? null : normaliseAccountEmail(email);
    await serialised(async () => {
      // Store null explicitly. Removing the key would collapse "observed signed
      // out/unknown" into "this installation has never observed an account",
      // making the fail-closed A → null → B transition impossible to audit.
      await chrome.storage.local.set({ [KEYS.accountEmail]: normalised });
    });
  } catch {
    // Storage refusing to write costs one late account transition, not correctness.
  }
}

export async function writeAccountId(accountId: string | null): Promise<void> {
  if (accountId === null) {
    await chrome.storage.local.remove(KEYS.account);
    return;
  }
  await chrome.storage.local.set({ [KEYS.account]: accountId });
}

/* ---- History ------------------------------------------------------------- */

/** Every rollup held, for every account, oldest first. */
export async function readAllHistory(): Promise<DailyRollup[]> {
  const stored = await chrome.storage.local.get(KEYS.history);
  const value = stored[KEYS.history];
  if (!Array.isArray(value)) return [];
  return value.filter(isRollup).map(withHourly).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The rollups belonging to one account, oldest first.
 *
 * Untagged rollups — written before Wick tracked accounts — count as this
 * account's, since there was only ever one account writing them. A tagged
 * rollup wins over an untagged one for the same day: once an account has
 * claimed a date, the legacy row for that date is its own past.
 *
 * Passing `null` returns the untagged rollups only, which is what a signed-out
 * or unidentified session should see rather than another account's week.
 */
export async function readHistory(accountId: string | null = null): Promise<DailyRollup[]> {
  const all = await readAllHistory();
  const untagged = (rollup: DailyRollup) => rollup.accountId === undefined;

  if (accountId === null) return all.filter(untagged);

  const mine = all.filter((rollup) => rollup.accountId === accountId);
  const claimed = new Set(mine.map((rollup) => rollup.date));
  const legacy = all.filter((rollup) => untagged(rollup) && !claimed.has(rollup.date));

  return [...legacy, ...mine].sort((a, b) => a.date.localeCompare(b.date));
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
  accountId: string | null = null,
): Promise<DailyRollup> {
  return serialised(async () => {
    const history = await readAllHistory();
    const merged = todayRollup(history, localDateKey(at), accountId);

    for (const [key, value] of Object.entries(utilizations)) {
      if (!Number.isFinite(value)) continue;
      const previous = merged.windows[key];
      merged.windows[key] = previous === undefined ? value : Math.max(previous, value);
    }

    await writeRollup(merged, history);
    return merged;
  });
}

/**
 * Increment the organisation-scoped local history counter from trusted code.
 * Page-derived completion hints must never call this, and publication never
 * reads it; `recordConfirmedLeaderboardMessage` owns the separate email ledger.
 */
export async function recordMessage(at: number, accountId: string | null = null): Promise<void> {
  await serialised(async () => {
    const history = await readAllHistory();
    const merged = todayRollup(history, localDateKey(at), accountId);

    merged.messageCount += 1;
    const hour = new Date(at).getHours();
    merged.hourlyMessages[hour] = (merged.hourlyMessages[hour] ?? 0) + 1;

    await writeRollup(merged, history);
  });
}

/**
 * Today's rollup for one account, ready to fold into.
 *
 * An untagged rollup for the same day is adopted rather than duplicated: it was
 * written before accounts existed, by this user, and splitting one day in two
 * because Wick learned a new fact about it would put a hole in the record.
 */
function todayRollup(
  history: DailyRollup[],
  date: string,
  accountId: string | null,
): DailyRollup {
  const existing =
    history.find((day) => day.date === date && day.accountId === (accountId ?? undefined)) ??
    (accountId === null
      ? undefined
      : history.find((day) => day.date === date && day.accountId === undefined));

  const base: DailyRollup = existing
    ? { ...existing, windows: { ...existing.windows }, hourlyMessages: [...existing.hourlyMessages] }
    : { date, windows: {}, messageCount: 0, hourlyMessages: emptyHours() };

  return accountId === null ? base : { ...base, accountId };
}

async function writeRollup(rollup: DailyRollup, history: DailyRollup[]): Promise<void> {
  const others = history.filter(
    (day) =>
      day.date !== rollup.date ||
      (day.accountId !== rollup.accountId && day.accountId !== undefined),
  );

  const all = [...others, rollup].sort((a, b) => a.date.localeCompare(b.date));

  // Retention counts days, not rows: an account's own record must not be cut
  // short because a second account was used on some of the same days.
  const dates = [...new Set(all.map((day) => day.date))];
  const kept = new Set(dates.slice(-HISTORY_RETENTION_DAYS));

  await chrome.storage.local.set({ [KEYS.history]: all.filter((day) => kept.has(day.date)) });
}

/* ---- Leaderboard publication ledger ------------------------------------ */

/** Every structurally valid local publication row, oldest first. */
async function readAllLeaderboardLedger(): Promise<LeaderboardDailyEntry[]> {
  const stored = await chrome.storage.local.get(KEYS.boardLedger);
  const value = stored[KEYS.boardLedger];
  if (!Array.isArray(value)) return [];
  return value.filter(isLeaderboardEntry).sort((a, b) => a.date.localeCompare(b.date));
}

/** Rows for one normalized account observation. No organisation fallback. */
export async function readLeaderboardLedger(
  email: string | null,
): Promise<LeaderboardDailyEntry[]> {
  if (email === null) return readAllLeaderboardLedger();
  const normalised = normaliseAccountEmail(email);
  if (normalised === null) return [];
  return (await readAllLeaderboardLedger()).filter((entry) => entry.email === normalised);
}

/**
 * Increment the publishable ledger from a trusted accepted-completion signal.
 *
 * No current protocol path calls this. MAIN-world stream/content-type evidence
 * is page-forgeable and therefore cannot satisfy this API's caller contract.
 * Keeping the API separate makes a future owner-verified confirmation explicit
 * without ever inferring totals from ambiguous organisation rollups.
 */
export async function recordConfirmedLeaderboardMessage(
  email: string,
  at: number,
): Promise<boolean> {
  const normalised = normaliseAccountEmail(email);
  if (normalised === null || !Number.isFinite(at)) return false;

  return serialised(async () => {
    const ledger = await readAllLeaderboardLedger();
    const date = localDateKey(at);
    const existing = ledger.find((entry) => entry.email === normalised && entry.date === date);
    const next: LeaderboardDailyEntry = {
      email: normalised,
      date,
      messages: (existing?.messages ?? 0) + 1,
    };
    const all = [
      ...ledger.filter((entry) => entry.email !== normalised || entry.date !== date),
      next,
    ].sort((a, b) => a.date.localeCompare(b.date));

    // Retention is an inclusive local-calendar window, not a count of active
    // dates. Otherwise a sparse account can keep an arbitrarily old row at the
    // front of its backlog, where the server will reject it forever. Anchor to
    // this email's newest row so an out-of-order confirmation cannot widen the
    // partition or let another account's activity evict it.
    const newestDate = all
      .filter((entry) => entry.email === normalised)
      .reduce((latest, entry) => (entry.date > latest ? entry.date : latest), date);
    const retainedFrom = leaderboardRetentionStartForDate(newestDate);

    await chrome.storage.local.set({
      [KEYS.boardLedger]: all.filter(
        (entry) => entry.email !== normalised || entry.date >= retainedFrom,
      ),
    });
    return true;
  });
}

/** Oldest local date in the inclusive leaderboard retention window. */
export function leaderboardRetentionStart(at: number): string {
  return leaderboardRetentionStartForDate(localDateKey(at));
}

function leaderboardRetentionStartForDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(0);
  // The components are already a local calendar date. UTC is used only as a
  // DST-free calendar calculator; converting the original timestamp again
  // would make 23/25-hour days and timezone offsets part of date arithmetic.
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year ?? 0, (month ?? 1) - 1, day ?? 1);
  date.setUTCDate(date.getUTCDate() - (LEADERBOARD_RETENTION_DAYS - 1));
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
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
  await serialised(async () => {
    const next = [...(await readAlerts()), alert].slice(-ALERT_RETENTION);
    await chrome.storage.local.set({ [KEYS.alerts]: next });
  });
}

/* ---- Assembled state ----------------------------------------------------- */

/**
 * Everything the interface needs, in one read.
 *
 * History is the current account's. A snapshot belonging to some other account
 * is dropped rather than shown: it is a real reading, but it is not a reading
 * about the person looking at the panel.
 */
export async function readState(): Promise<WickState> {
  const accountId = await readAccountId();
  const [snapshot, history, settings, status] = await Promise.all([
    readSnapshot(),
    readHistory(accountId),
    readSettings(),
    readStatus(),
  ]);

  const mine =
    snapshot === null || snapshot.accountId === null || snapshot.accountId === accountId
      ? snapshot
      : null;

  return { snapshot: mine, history, settings, status };
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




function isLeaderboardEntry(value: unknown): value is LeaderboardDailyEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<LeaderboardDailyEntry>;
  if (typeof entry.email !== 'string' || normaliseAccountEmail(entry.email) !== entry.email) {
    return false;
  }
  return (
    typeof entry.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
    Number.isSafeInteger(entry.messages) &&
    (entry.messages ?? -1) >= 0
  );
}

/**
 * Choosing between windows, and merging readings of them.
 *
 * Two jobs that used to be done by array index and by wholesale replacement,
 * and neither survives contact with what claude.ai actually returns:
 *
 * 1. **Selection.** `windows[1] ?? windows[0]` assumed the weekly allowance is
 *    always second. Nothing promises that. Response order is the provider's
 *    business, and an account with model-scoped weeklies reports more than two
 *    windows. Selection here is by `role`, with a structural fallback for a
 *    provider that has not classified anything.
 *
 * 2. **Merging.** A snapshot used to be replaced whole by whichever reading
 *    landed last. That erases: an authoritative response listing no windows —
 *    which is what a free plan returns — would wipe out perfectly good numbers
 *    read off a completion stream. Merging is per window, per source, and never
 *    lets a lower-trust reading drag a fresher one backwards.
 *
 * Pure. No `chrome.*`, no I/O, and no clock of its own — `now` is passed in.
 */

import type { LimitWindow, Snapshot, SnapshotSource } from './types';

/**
 * How long a window with no reset time is kept after it was last observed.
 *
 * A window that reports when it resets is pruned by that; one that does not
 * needs some ceiling, or a window the provider stopped reporting would sit on
 * the panel forever. A day is longer than any cadence Wick polls at, so a live
 * window is always refreshed well before this.
 */
export const WINDOW_STALE_MS = 24 * 60 * 60 * 1000;

/** Display order. Session first, then the allowance, then everything else. */
const ROLE_ORDER = ['session', 'weekly', 'weekly-model', 'overage', 'other'] as const;

/* ---- Selection ----------------------------------------------------------- */

/**
 * The short rolling window, or `null`.
 *
 * Falls back to the active window that resets soonest, which is what a session
 * window is structurally, for a provider that reports no role.
 */
export function sessionWindow(windows: readonly LimitWindow[]): LimitWindow | null {
  const tagged = windows.find((window) => window.role === 'session');
  if (tagged) return tagged;

  const active = windows.filter((window) => window.active && window.resetsAt !== null);
  if (active.length === 0) return windows[0] ?? null;

  return active.reduce((best, window) =>
    (window.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity) ? window : best,
  );
}

/**
 * The window the forecast is about, and the one the threshold alert watches.
 *
 * The account-wide weekly when there is one. Failing that, the model-scoped
 * weekly closest to its bound — that is the one the user will actually hit
 * first, and a forecast about a window they will not reach is worse than
 * useless. Failing that, the active window that resets furthest out, which is
 * the weekly one for any provider that meters this way.
 */
export function allowanceWindow(windows: readonly LimitWindow[]): LimitWindow | null {
  const weekly = windows.find((window) => window.role === 'weekly');
  if (weekly) return weekly;

  const scoped = windows.filter((window) => window.role === 'weekly-model');
  if (scoped.length > 0) {
    return scoped.reduce((worst, window) =>
      (window.utilization ?? -1) > (worst.utilization ?? -1) ? window : worst,
    );
  }

  const active = windows.filter((window) => window.active);
  if (active.length === 0) return null;

  let best: LimitWindow | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const window of active) {
    if (window.resetsAt === null) continue;
    if (window.resetsAt >= bestAt) {
      best = window;
      bestAt = window.resetsAt;
    }
  }

  return best ?? active[active.length - 1] ?? null;
}

/** Windows in display order: session, allowance, scoped weeklies, the rest. */
export function orderWindows(windows: readonly LimitWindow[]): LimitWindow[] {
  return [...windows].sort((a, b) => rank(a) - rank(b));
}

function rank(window: LimitWindow): number {
  const index = ROLE_ORDER.indexOf(window.role);
  return index === -1 ? ROLE_ORDER.length : index;
}

/* ---- Merging ------------------------------------------------------------- */

/** How much a reading is trusted. Higher wins a tie at the same instant. */
const TRUST: Record<SnapshotSource, number> = { usage: 3, rejection: 2, stream: 1 };

/** One reading, as it arrives at the store. */
export interface Reading {
  providerId: string;
  accountId: string | null;
  windows: LimitWindow[];
  source: SnapshotSource;
  /** Epoch milliseconds the reading was taken. */
  at: number;
}

/**
 * Fold a reading into the snapshot that is already stored.
 *
 * Returns the snapshot to store, or `null` to leave what is there alone.
 *
 * The rules, and the reason for each:
 *
 * - **A reading for a different account replaces everything.** Two accounts'
 *   windows must never appear side by side, and merging them by key would do
 *   exactly that.
 * - **A non-empty authoritative reading is the whole truth.** It lists every
 *   window the account has, so anything missing from it no longer exists.
 * - **An empty authoritative reading erases nothing.** claude.ai answers a free
 *   plan with no windows at all, and the only numbers such an account ever gets
 *   come off the completion stream. Reading "the endpoint listed nothing" as
 *   "you have nothing" would delete the only evidence Wick had.
 * - **Optimistic readings merge per window, and only forwards.** A stream event
 *   or a refusal updates the windows it mentions and leaves the rest alone; one
 *   older than what is stored is dropped rather than allowed to drag the display
 *   backwards.
 * - **Windows that have reset are not carried forward.** A percentage about a
 *   cycle that has ended is not stale, it is wrong.
 */
export function mergeReading(
  existing: Snapshot | null,
  reading: Reading,
  now: number,
): Snapshot | null {
  const incoming = stamp(reading);
  if (incoming.length === 0 && reading.source !== 'usage') return null;

  const sameAccount =
    existing !== null &&
    existing.providerId === reading.providerId &&
    existing.accountId === reading.accountId;

  const kept = sameAccount ? live(existing.windows, now) : [];

  // An authoritative reading that found windows describes the account
  // completely: what it does not mention, the account does not have.
  const authoritative = reading.source === 'usage' && incoming.length > 0;
  const base = authoritative ? [] : kept;

  const merged = new Map<string, LimitWindow>();
  for (const window of base) merged.set(window.key, window);
  for (const window of incoming) {
    const previous = merged.get(window.key);
    if (previous && !supersedes(window, previous)) continue;
    merged.set(window.key, window);
  }

  const windows = orderWindows([...merged.values()]);

  if (sameAccount && !changed(existing, windows, reading)) return null;

  return {
    providerId: reading.providerId,
    accountId: reading.accountId,
    windows,
    fetchedAt: reading.at,
    source: newestSource(windows) ?? reading.source,
  };
}

/** Attach provenance. Providers report numbers; only the store knows the reading. */
function stamp(reading: Reading): LimitWindow[] {
  return reading.windows.map((window) => ({
    ...window,
    source: reading.source,
    observedAt: reading.at,
  }));
}

/** Whether `next` should replace `previous` for the same key. */
function supersedes(next: LimitWindow, previous: LimitWindow): boolean {
  const nextAt = next.observedAt ?? 0;
  const previousAt = previous.observedAt ?? 0;
  if (nextAt !== previousAt) return nextAt > previousAt;
  // Same instant: the more trustworthy reading wins, so a poll and a stream
  // event landing in the same millisecond do not depend on arrival order.
  return TRUST[next.source ?? 'stream'] >= TRUST[previous.source ?? 'stream'];
}

/** Windows still describing a live cycle. */
function live(windows: readonly LimitWindow[], now: number): LimitWindow[] {
  return windows.filter((window) => {
    if (window.resetsAt !== null) return window.resetsAt > now;
    return now - (window.observedAt ?? 0) < WINDOW_STALE_MS;
  });
}

function newestSource(windows: readonly LimitWindow[]): SnapshotSource | null {
  let best: LimitWindow | null = null;
  for (const window of windows) {
    if (best === null || supersedes(window, best)) best = window;
  }
  return best?.source ?? null;
}

/**
 * Whether the merge produced anything worth writing.
 *
 * Every write wakes the icon renderer and the alert dispatcher through
 * `chrome.storage.onChanged`, so a poll that learns nothing new should be silent
 * rather than re-broadcasting the state it already had.
 */
function changed(existing: Snapshot, windows: readonly LimitWindow[], reading: Reading): boolean {
  if (existing.windows.length !== windows.length) return true;
  if (reading.source === 'usage') return true;

  return windows.some((window) => {
    const before = existing.windows.find((candidate) => candidate.key === window.key);
    if (before === undefined) return true;
    return (
      before.utilization !== window.utilization ||
      before.status !== window.status ||
      before.resetsAt !== window.resetsAt ||
      before.active !== window.active
    );
  });
}

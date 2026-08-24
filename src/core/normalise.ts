/**
 * Turning provider wire shapes into `LimitWindow`s without ever throwing.
 *
 * These functions exist because claude.ai reports the same facts three
 * different ways depending on where you read them — ISO strings in one place
 * and unix seconds in another, 0–100 integers in one place and 0–1 floats in
 * another — and because all of it is undocumented and will drift.
 *
 * Every function here is total: it takes `unknown` and returns something
 * usable, or returns `null` to mean "the provider did not tell us". None of
 * them throw. A shape change should degrade the display, never take down the
 * service worker.
 *
 * Pure. No I/O, no `chrome.*`.
 */

import { THRESHOLDS, type LimitStatus, type ThresholdState } from './types';

/**
 * Anything before this, read as milliseconds, is in 1970 — so the value was
 * almost certainly seconds. 2001-09-09, the point where unix seconds reached
 * ten digits.
 */
const SECONDS_MS_BOUNDARY = 1_000_000_000_000;

/** Sanity bound on reset times: roughly 1973 to 2286. */
const PLAUSIBLE_MS_RANGE = { min: 100_000_000_000, max: 9_999_999_999_999 };

/**
 * Normalise a reset time to epoch milliseconds.
 *
 * Accepts an ISO 8601 string (the usage endpoint), a unix-seconds number (the
 * `message_limit` event), or milliseconds. Distinguishing seconds from
 * milliseconds by magnitude is a heuristic, but the two are eleven orders of
 * magnitude apart in this range, so it is not a close call.
 */
export function normaliseResetsAt(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < SECONDS_MS_BOUNDARY ? value * 1000 : value;
    return inPlausibleRange(ms) ? Math.round(ms) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;

    // A bare number arriving as a string is still a timestamp.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return normaliseResetsAt(Number(trimmed));
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    return inPlausibleRange(parsed) ? parsed : null;
  }

  return null;
}

function inPlausibleRange(ms: number): boolean {
  return ms >= PLAUSIBLE_MS_RANGE.min && ms <= PLAUSIBLE_MS_RANGE.max;
}

/**
 * Normalise a consumption figure to 0–100.
 *
 * The usage endpoint sends `percent` as an integer 0–100; the stream sends
 * `utilization` as a float 0–1 rounded to two decimals. They are
 * indistinguishable at the low end — 1 could be 1% or 100% — so the caller
 * states which scale it is reading rather than letting this guess.
 */
export function normaliseUtilization(
  value: unknown,
  scale: 'percent' | 'fraction',
): number | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0) return null;

  const percent = scale === 'fraction' ? raw * 100 : raw;

  // Overage windows can legitimately exceed their nominal bound. Clamping to
  // 100 keeps the bar inside its track without inventing a number, since
  // anything past 100 is displayed as exhausted either way.
  return Math.min(100, round2(percent));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Map a provider's status string onto `LimitStatus`.
 *
 * Unrecognised values become `'unknown'`, never `'ok'`. When claude.ai invents
 * a new status — and it will — Wick should say it does not know rather than
 * quietly report everything as fine.
 */
export function normaliseStatus(value: unknown): LimitStatus {
  if (typeof value !== 'string') return 'unknown';

  const s = value.trim().toLowerCase();
  if (s === '') return 'unknown';

  // Matched on substrings because the wire uses several spellings for the same
  // condition and adds new ones without notice.
  if (s.includes('exceed') || s.includes('reached') || s.includes('blocked')) return 'exceeded';
  if (s.includes('approach') || s.includes('warn') || s.includes('near')) return 'approaching';
  if (s === 'ok' || s === 'allowed' || s === 'active' || s === 'within_limit') return 'ok';

  return 'unknown';
}

/**
 * Decide the colour state for a window.
 *
 * **Status wins over the number.** A window reporting 98% while already
 * refusing sends is critical, not nearly-critical: showing "98%" next to a
 * composer that will not send makes the extension look broken.
 *
 * With no status and no number there is nothing to say, so the answer is
 * `'unknown'` — which renders as a gap, not as zero.
 */
export function thresholdState(
  utilization: number | null,
  status: LimitStatus = 'unknown',
): ThresholdState {
  if (status === 'exceeded') return 'crit';
  if (utilization === null) return status === 'approaching' ? 'warn' : 'unknown';
  if (utilization > THRESHOLDS.crit) return 'crit';
  if (utilization >= THRESHOLDS.warn) return 'warn';
  // A provider flagging a window as approaching outranks a comfortable number.
  return status === 'approaching' ? 'warn' : 'ok';
}

/**
 * Read a property off a value that may be anything at all.
 *
 * Wire parsing walks over objects that are only believed to have a given shape.
 * This keeps that belief from turning into a thrown error three levels down.
 */
export function field(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Parse JSON that may not be JSON, and may be double-encoded.
 *
 * Refusal responses nest their limit report as a JSON string inside an error
 * message field, so the useful payload is one `JSON.parse` deeper than it
 * looks. Returns `null` rather than throwing.
 */
export function parseMaybeJson(value: unknown, depth = 2): unknown {
  if (typeof value !== 'string' || depth <= 0) return value;
  try {
    return parseMaybeJson(JSON.parse(value) as unknown, depth - 1);
  } catch {
    return value;
  }
}

/** Local calendar date as `YYYY-MM-DD`, for keying daily rollups. */
export function localDateKey(at: number): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

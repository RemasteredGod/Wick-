/**
 * Which board a submitted day belongs to.
 *
 * A submission carries one **local calendar day** as `YYYY-MM-DD` (ADR 0006).
 * That is deliberately not an instant: the relay never learns the submitter's
 * timezone, so there is nothing to convert and no offset to guess. Everything
 * here is plain-date arithmetic on that string, done through `Date.UTC` so the
 * host's own zone cannot change an answer.
 *
 * The weekly board "resets Monday 00:00 UTC" in the sense that Monday is the
 * first day a new week accepts — not that a timestamp is compared against a
 * clock. Two users submitting the same calendar day land in the same week
 * regardless of where they are.
 *
 * Pure. No clock of its own; callers pass `today` where a boundary is needed.
 */

/** A calendar day, `YYYY-MM-DD`. Never an instant. */
export type Day = string;

/** The three boards from ADR 0006. */
export type Period = 'week' | 'month' | 'all';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether a string is a real calendar day.
 *
 * Shape alone is not enough: `2026-02-30` matches the pattern and is not a
 * date. Round-tripping through `Date.UTC` rejects it, because JavaScript
 * normalises the overflow to March and the parts stop matching.
 */
export function isDay(value: unknown): value is Day {
  if (typeof value !== 'string') return false;

  const match = DAY_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  return (
    back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
  );
}

/** Epoch milliseconds at 00:00 UTC on a day. Callers must pass a valid `Day`. */
function startOf(day: Day): number {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toDay(at: number): Day {
  const date = new Date(at);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The Monday on or before a day.
 *
 * `getUTCDay` numbers Sunday as 0, which would put Sunday at the *start* of the
 * following week rather than the end of the current one. The `+ 6) % 7` shifts
 * the origin to Monday so Sunday reads as day six and folds backwards.
 */
export function weekStart(day: Day): Day {
  const at = startOf(day);
  if (Number.isNaN(at)) return day;

  const weekday = (new Date(at).getUTCDay() + 6) % 7;
  return toDay(at - weekday * MS_PER_DAY);
}

/** The first day of a day's month. */
export function monthStart(day: Day): Day {
  const match = DAY_PATTERN.exec(day);
  return match === null ? day : `${match[1]}-${match[2]}-01`;
}

/**
 * Whether a day counts towards a board as of `today`.
 *
 * `all` takes everything, including days in the future. A clock skewed forward
 * on a submitter's machine is not a reason to silently drop their work — the
 * per-day submission cap in ADR 0006 is what bounds abuse here, not this.
 */
export function inPeriod(day: Day, period: Period, today: Day): boolean {
  if (period === 'all') return true;
  if (period === 'week') return weekStart(day) === weekStart(today);
  return monthStart(day) === monthStart(today);
}

/** Days between two days, positive when `to` is later. For streaks and pace. */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((startOf(to) - startOf(from)) / MS_PER_DAY);
}

/**
 * Validating one daily submission.
 *
 * ADR 0005 sets the rule this file exists to enforce: **a count the first-party
 * record does not provide is unknown, not zero.** A submission that is missing,
 * malformed, conflicting or out of range contributes *nothing*. It is never
 * partially accepted, and a missing counter is never filled in with a zero that
 * would rank the submitter as having done less work rather than as having sent
 * an unreadable record.
 *
 * The reporter aggregates locally into bounded per-model families. The relay
 * sums those families into one row and stores no family labels (ADR 0006), so
 * this module is where the map stops existing.
 *
 * Pure. Takes `unknown` because it runs on a request body.
 */

import { isDay, type Day } from './periods';

/** The four first-party counters, exactly as Claude Code writes them. */
export interface Counters {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** What one accepted submission becomes: one row, no family labels. */
export interface DailyRow {
  day: Day;
  sessions: number;
  counters: Counters;
}

/** Why a submission was refused. Callers map these to a status, never a reason string. */
export type SubmissionRejection =
  | 'malformed'
  | 'bad-day'
  | 'bad-sessions'
  | 'bad-counters'
  | 'too-many-families'
  | 'implausible';

export type SubmissionResult =
  | { ok: true; row: DailyRow }
  | { ok: false; rejection: SubmissionRejection };

/**
 * How many model families one day may report.
 *
 * "Bounded" in ADR 0006 needs a number. Claude Code writes a handful of model
 * ids per day at most; a submission claiming dozens is either a different data
 * shape or an attempt to make the sum expensive.
 */
export const MAX_FAMILIES = 16;

/**
 * The most sessions one calendar day may claim.
 *
 * A sanity ceiling, not a rate limit — plan.md §4 asks for one so that absurd
 * values are refused rather than published. It is deliberately generous: the
 * point is to catch a corrupt or synthetic record, not to judge how hard
 * somebody worked.
 */
export const MAX_SESSIONS = 1_000;

/**
 * The most tokens one counter may claim in a day.
 *
 * Same purpose as `MAX_SESSIONS`, and the same generosity. A day above this is
 * not a heavy user; it is a record that has lost its units.
 */
export const MAX_COUNTER = 2_000_000_000;

/**
 * Read a submission body.
 *
 * Every counter must be present on every family. ADR 0005 is explicit that all
 * four are required and that a partial record contributes nothing, so a family
 * missing `cacheRead` rejects the whole submission rather than that one family.
 */
export function readSubmission(value: unknown): SubmissionResult {
  if (typeof value !== 'object' || value === null) return { ok: false, rejection: 'malformed' };

  const body = value as { day?: unknown; sessions?: unknown; families?: unknown };

  if (!isDay(body.day)) return { ok: false, rejection: 'bad-day' };
  if (!isCount(body.sessions)) return { ok: false, rejection: 'bad-sessions' };
  if (body.sessions > MAX_SESSIONS) return { ok: false, rejection: 'implausible' };

  if (typeof body.families !== 'object' || body.families === null) {
    return { ok: false, rejection: 'bad-counters' };
  }

  const entries = Object.values(body.families as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, rejection: 'bad-counters' };
  if (entries.length > MAX_FAMILIES) return { ok: false, rejection: 'too-many-families' };

  const total: Counters = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

  for (const entry of entries) {
    const counters = readCounters(entry);
    if (counters === null) return { ok: false, rejection: 'bad-counters' };

    total.input += counters.input;
    total.output += counters.output;
    total.cacheCreation += counters.cacheCreation;
    total.cacheRead += counters.cacheRead;
  }

  // Checked after summing, not per family: the ceiling is about the day.
  if (
    total.input > MAX_COUNTER ||
    total.output > MAX_COUNTER ||
    total.cacheCreation > MAX_COUNTER ||
    total.cacheRead > MAX_COUNTER
  ) {
    return { ok: false, rejection: 'implausible' };
  }

  return { ok: true, row: { day: body.day, sessions: body.sessions, counters: total } };
}

/** One family's four counters, or `null` if any of them is not readable. */
function readCounters(value: unknown): Counters | null {
  if (typeof value !== 'object' || value === null) return null;

  const family = value as {
    input?: unknown;
    output?: unknown;
    cacheCreation?: unknown;
    cacheRead?: unknown;
  };

  if (
    !isCount(family.input) ||
    !isCount(family.output) ||
    !isCount(family.cacheCreation) ||
    !isCount(family.cacheRead)
  ) {
    return null;
  }

  return {
    input: family.input,
    output: family.output,
    cacheCreation: family.cacheCreation,
    cacheRead: family.cacheRead,
  };
}

/**
 * A non-negative safe integer.
 *
 * `Number.isSafeInteger` rejects `NaN`, infinities, floats, and anything past
 * 2^53 where addition silently stops being exact — which matters here, because
 * these values are summed.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Add two counter sets. Used to fold many days into one board figure. */
export function addCounters(a: Counters, b: Counters): Counters {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** The zero counter set. Not a stand-in for a missing reading — see the header. */
export function emptyCounters(): Counters {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

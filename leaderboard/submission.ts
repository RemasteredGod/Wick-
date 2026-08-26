/**
 * Validating one daily submission.
 *
 * **One number a day: how many messages were sent.** ADR 0006 ranked
 * `input + output` tokens read out of Claude Code transcripts by a separate
 * reporter. The extension is the submitter now, and it cannot produce that
 * figure — claude.ai reports percentages, and counting or estimating tokens is
 * ruled out by ADR 0001 and forbidden outright by AGENTS.md. Percentages do not
 * rank: eighty per cent of a Pro allowance and eighty per cent of a Max
 * allowance are different amounts of work, so a board ordered by them would
 * mostly be ordering plan tiers. A message count is the one absolute figure the
 * extension already holds and the only one that compares across accounts.
 *
 * The rule that carries over unchanged is ADR 0005's: **a count the first-party
 * record does not provide is unknown, not zero.** A submission that is missing,
 * malformed or out of range contributes *nothing*. It is never partially
 * accepted, and a missing count is never filled in with a zero that would rank
 * the submitter as having done less work rather than as having sent an
 * unreadable record.
 *
 * Pure. Takes `unknown` because it runs on a request body.
 */

import { isDay, type Day } from './periods.js';

/** What one accepted submission becomes: one day, one count. */
export interface DailyRow {
  day: Day;
  /** Messages sent that day, as the extension counted them locally. */
  messages: number;
}

/** Why a submission was refused. Callers map these to a status, never a reason string. */
export type SubmissionRejection = 'malformed' | 'bad-day' | 'bad-messages' | 'implausible';

export type SubmissionResult =
  | { ok: true; row: DailyRow }
  | { ok: false; rejection: SubmissionRejection };

/**
 * The most messages one calendar day may claim.
 *
 * A sanity ceiling, not a rate limit — the point is to refuse a corrupt or
 * synthetic record rather than to judge how hard somebody worked, so it is
 * deliberately far above any plausible day. A human sending one message every
 * ten seconds for twenty-four hours lands under this.
 */
export const MAX_MESSAGES = 10_000;

/**
 * Read a submission body.
 *
 * Two fields, both required. There is deliberately nothing optional here: a
 * body carrying anything else is a body written against a different version,
 * and taking the half of it that parses would publish a day nobody meant to
 * send.
 */
export function readSubmission(value: unknown): SubmissionResult {
  if (typeof value !== 'object' || value === null) return { ok: false, rejection: 'malformed' };

  const body = value as { day?: unknown; messages?: unknown };

  if (!isDay(body.day)) return { ok: false, rejection: 'bad-day' };
  if (!isCount(body.messages)) return { ok: false, rejection: 'bad-messages' };
  if (body.messages > MAX_MESSAGES) return { ok: false, rejection: 'implausible' };

  return { ok: true, row: { day: body.day, messages: body.messages } };
}

/**
 * A non-negative safe integer.
 *
 * `Number.isSafeInteger` rejects `NaN`, infinities, floats, and anything past
 * 2^53 where addition silently stops being exact — which matters here, because
 * these values are summed across a period.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

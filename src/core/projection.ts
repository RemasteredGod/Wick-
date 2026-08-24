/**
 * Burn-rate projection — when the user runs out.
 *
 * This is the product. Every other layer exists to feed it or display it, and
 * it is the only part that has to be genuinely correct: a percentage that is
 * slightly stale is a small bug, but "you run out Tuesday" when the real answer
 * is Thursday is the whole extension being wrong.
 *
 * Accordingly: pure functions only. No `chrome.*`, no I/O, no clock reads that
 * are not passed in. `now` is a parameter so that every branch is reachable
 * from a test without faking time.
 */

import { localDateKey } from './normalise';
import type { DailyRollup, LimitWindow, Projection, ProjectionConfidence } from './types';

/**
 * Days of history below which no projection is attempted.
 *
 * Two points define a line through any noise at all, so two days of history
 * will confidently project nonsense. Three is the minimum at which a claim of
 * "your current pace" means anything, and even then it is reported as low
 * confidence.
 */
export const MIN_HISTORY_DAYS = 3;

/** Days of history at which the estimate is treated as fully weighted. */
export const FULL_CONFIDENCE_DAYS = 7;

/**
 * Half-life of a day's influence on pace, in days.
 *
 * Exponential decay rather than a flat mean, because what the user did on
 * Monday says less about Friday than Thursday does. Three days is the shortest
 * half-life that still needs two heavy days in a row to move the answer far: a
 * single spike four days back carries about a third of yesterday's weight, so
 * it bends the estimate without owning it. Shorten it to react faster, lengthen
 * it to smooth harder.
 */
export const PACE_HALF_LIFE_DAYS = 3;

/**
 * Above this coefficient of variation, daily usage counts as highly variable
 * and confidence drops a step.
 *
 * Coefficient of variation — standard deviation over mean — rather than the
 * standard deviation alone, because it is scale-free: 5 points of scatter is
 * noise around a 40-point-a-day habit and chaos around a 3-point-a-day one.
 * 0.75 sits well above the ragged-but-consistent week (a tenth or so) and below
 * one heavy afternoon among flat days (comfortably past 1).
 */
export const PACE_VARIABILITY_LIMIT = 0.75;

/**
 * Deltas needed before variability is judged at all.
 *
 * With two observations there is no such thing as an outlier — either one is
 * equally entitled to be called the odd one out.
 */
const MIN_VARIABILITY_SAMPLES = 3;

const DAY_MS = 86_400_000;

export interface ProjectionInput {
  /** The window being projected. */
  window: LimitWindow;
  /**
   * Daily rollups, any order, possibly with gaps. Days on which the user did
   * not touch Claude are legitimately absent and must not be read as zeros —
   * an absent day is missing evidence, not evidence of nothing.
   */
  history: DailyRollup[];
  /** Epoch milliseconds. Injected rather than read, so tests can control it. */
  now: number;
}

/** One day's consumption, with how long ago it happened. */
interface DailyRate {
  /** Percentage points consumed per day. Never negative. */
  rate: number;
  /** Whole days between the observation and today. */
  ageDays: number;
}

/**
 * Project when `window` will be exhausted.
 *
 * Returns `exhaustionEstimate: null` whenever there is no honest answer —
 * because there is not enough history, because the window is not moving, or
 * because at the current pace it resets before it runs out. `reason` says
 * which, and the interface shows it.
 */
export function project(input: ProjectionInput): Projection {
  const { window, history, now } = input;

  const relevant = usableHistory(window.key, history, now);
  const rates = relevant.length >= MIN_HISTORY_DAYS ? dailyRates(window.key, relevant, now) : [];
  const pace = rates.length > 0 ? weightedPace(rates) : null;

  // Status outranks the number, and it outranks the history gate too: being
  // refused is observed, not projected, so it needs no evidence behind it. The
  // estimate is `now` rather than null because the interface renders an
  // estimate as a time and null as "we don't know" — and "already gone" is the
  // one thing here we do know.
  if (window.status === 'exceeded') {
    return {
      exhaustionEstimate: now,
      confidence: 'high',
      pace,
      reason: 'Limit already reached',
    };
  }

  if (relevant.length < MIN_HISTORY_DAYS) {
    const have = relevant.length;
    return {
      exhaustionEstimate: null,
      confidence: 'none',
      pace: null,
      reason:
        have === 0
          ? 'No history yet'
          : `Only ${have} ${have === 1 ? 'day' : 'days'} of history — need ${MIN_HISTORY_DAYS}`,
    };
  }

  if (pace === null) {
    // Enough days, but every one of them sat on the far side of a reset from
    // its neighbour, so nothing survived as a measure of consumption.
    return {
      exhaustionEstimate: null,
      confidence: 'none',
      pace: null,
      reason: 'No usable trend yet',
    };
  }

  // A spike among flat days should cost confidence, not just move the number:
  // the pace is a worse summary of scattered usage than of steady usage, and
  // saying so is the honest version of reporting it.
  const uneven = isHighlyVariable(rates);
  const days = relevant.length;
  const confidence = uneven ? degrade(confidenceFor(days)) : confidenceFor(days);
  const reason = uneven ? 'Usage is uneven day to day' : `Based on ${days} days of history`;

  if (pace <= 0) {
    return { exhaustionEstimate: null, confidence, pace, reason: 'No recent usage' };
  }

  // A missing utilization is missing, not zero. Without it there is no
  // remaining quota to divide by the pace, so there is no estimate — but the
  // pace itself was measured and is still worth reporting.
  if (window.utilization === null) {
    return { exhaustionEstimate: null, confidence, pace, reason: 'Current usage unknown' };
  }

  const remaining = Math.max(0, 100 - window.utilization);
  const estimate = now + (remaining / pace) * DAY_MS;

  // The common healthy case: the window rolls over before the burn rate eats
  // it. Nothing to warn about, so say so as reassurance rather than as a gap.
  if (window.resetsAt !== null && window.resetsAt <= estimate) {
    return { exhaustionEstimate: null, confidence, pace, reason: 'Resets before you run out' };
  }

  return { exhaustionEstimate: Math.round(estimate), confidence, pace, reason };
}

/**
 * Rollups that carry a reading for this window and are old enough to be
 * complete.
 *
 * Today is excluded: it is partially elapsed, so treating it as a full day
 * understates pace every morning and overstates it every evening. The current
 * window's own utilization covers the present; history covers the past.
 */
export function usableHistory(
  windowKey: string,
  history: DailyRollup[],
  now: number,
): DailyRollup[] {
  const today = localDateKey(now);
  return history
    .filter((day) => day.date !== today && typeof day.windows[windowKey] === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * How much to trust an estimate built from `days` days of history.
 *
 * Exported so the interface and the projection agree on the wording rather than
 * each deciding what "enough" means.
 */
export function confidenceFor(days: number): ProjectionConfidence {
  if (days < MIN_HISTORY_DAYS) return 'none';
  if (days < FULL_CONFIDENCE_DAYS) return 'low';
  return days >= FULL_CONFIDENCE_DAYS * 2 ? 'high' : 'medium';
}

/**
 * Turn peak utilizations into per-day consumption.
 *
 * `DailyRollup.windows[key]` is the *peak* utilization that day, and
 * utilization accumulates within a window and collapses when the window rolls
 * over. So consumption is the day-over-day rise in that peak, and a fall means
 * the window reset — not that the user gave quota back.
 *
 * Negative deltas are discarded outright rather than clamped to zero. A clamped
 * reset would enter the average as a quiet day the user never had, dragging
 * pace down and telling them they are fine when they are not. Zero deltas are
 * kept: a day whose peak did not move is real evidence of not using it.
 *
 * A delta spanning a gap of N days is divided by N rather than dropped. The gap
 * hides *when* the rise happened but not *that* it happened, and spreading it
 * evenly is the only reading that does not invent a spike out of days nobody
 * watched; dropping it would throw away the one fact the record does contain.
 * The sample is then weighted at the later day's age, since that is the only
 * day of the gap we actually observed.
 */
function dailyRates(windowKey: string, sorted: DailyRollup[], now: number): DailyRate[] {
  const today = localDateKey(now);
  const rates: DailyRate[] = [];

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;

    const from = previous.windows[windowKey];
    const to = current.windows[windowKey];
    if (typeof from !== 'number' || typeof to !== 'number') continue;

    const span = daysBetween(previous.date, current.date);
    if (span <= 0) continue;

    const delta = to - from;
    if (delta < 0) continue;

    rates.push({ rate: delta / span, ageDays: daysBetween(current.date, today) });
  }

  return rates;
}

/**
 * Exponentially weighted mean of the daily rates.
 *
 * Recent days count for more, but every day still counts — a heavy afternoon
 * moves the answer, it does not become the answer.
 */
function weightedPace(rates: DailyRate[]): number {
  let weighted = 0;
  let total = 0;

  for (const { rate, ageDays } of rates) {
    const weight = Math.pow(0.5, ageDays / PACE_HALF_LIFE_DAYS);
    weighted += rate * weight;
    total += weight;
  }

  return total === 0 ? 0 : weighted / total;
}

/**
 * Whether daily usage scatters enough that the pace is a poor summary of it.
 *
 * Unweighted on purpose: this asks how consistent the user's habit is, and
 * discounting the older days would hide exactly the flat stretch that makes a
 * spike look like a spike.
 */
function isHighlyVariable(rates: DailyRate[]): boolean {
  if (rates.length < MIN_VARIABILITY_SAMPLES) return false;

  const mean = rates.reduce((sum, r) => sum + r.rate, 0) / rates.length;
  if (mean <= 0) return false;

  const variance = rates.reduce((sum, r) => sum + (r.rate - mean) ** 2, 0) / rates.length;
  return Math.sqrt(variance) / mean > PACE_VARIABILITY_LIMIT;
}

/**
 * Knock confidence down one step.
 *
 * `'low'` is the floor: below it is `'none'`, which the interface reads as "no
 * estimate", and returning that alongside a number contradicts itself. Three
 * uneven days are still three days of evidence.
 */
function degrade(confidence: ProjectionConfidence): ProjectionConfidence {
  switch (confidence) {
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    default:
      return confidence;
  }
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD` local dates.
 *
 * Compared at local noon so that a daylight-saving shift, which moves midnight
 * by an hour, cannot round a day to zero or two.
 */
function daysBetween(from: string, to: string): number {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

function parseDateKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(Number(year), Number(month) - 1, Number(day), 12).getTime();
}

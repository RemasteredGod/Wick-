import { describe, expect, it } from 'vitest';
import {
  FULL_CONFIDENCE_DAYS,
  MIN_HISTORY_DAYS,
  confidenceFor,
  project,
  usableHistory,
} from '~/core/projection';
import type { DailyRollup, LimitWindow } from '~/core/types';

const NOW = new Date(2026, 7, 24, 14, 0).getTime();
const DAY_MS = 86_400_000;

function dayKey(offsetDays: number): string {
  const d = new Date(NOW - offsetDays * DAY_MS);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** `peaks[0]` is today, `peaks[1]` yesterday, and so on. */
function history(peaks: number[], windowKey = '7d'): DailyRollup[] {
  return peaks.map((peak, offset) => ({
    date: dayKey(offset),
    windows: { [windowKey]: peak },
    messageCount: 10,
    hourlyMessages: new Array<number>(24).fill(0),
  }));
}

/** Rollups at chosen day offsets, so a record can have holes in it. */
function sparseHistory(peaksByOffset: Record<number, number>, windowKey = '7d'): DailyRollup[] {
  return Object.entries(peaksByOffset).map(([offset, peak]) => ({
    date: dayKey(Number(offset)),
    windows: { [windowKey]: peak },
    messageCount: 10,
    hourlyMessages: new Array<number>(24).fill(0),
  }));
}

const weekly: LimitWindow = {
  key: '7d',
  label: 'Weekly',
  shortLabel: 'Weekly',
  utilization: 82,
  status: 'ok',
  resetsAt: NOW + 3 * DAY_MS,
  active: true,
  role: 'weekly',
};

/** Seven complete days climbing 10 points a day, plus a partial today. */
const FLAT_WEEK = history([70, 60, 50, 40, 30, 20, 10, 0]);

/** Timestamps are milliseconds; a second of float drift is not a failure. */
function expectAbout(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(1000);
}

describe('project', () => {
  it('refuses to guess with no history at all', () => {
    const result = project({ window: weekly, history: [], now: NOW });

    expect(result.exhaustionEstimate).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.pace).toBeNull();
    expect(result.reason).toBe('No history yet');
  });

  it.each([1, 2])('refuses to guess with only %i complete day(s)', (days) => {
    // Two points define a line through any amount of noise, so two days of
    // history will confidently project nonsense.
    const peaks = [50, ...Array.from({ length: days }, (_, i) => 40 + i)];
    const result = project({ window: weekly, history: history(peaks), now: NOW });

    expect(result.exhaustionEstimate).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.reason).toContain(`need ${MIN_HISTORY_DAYS}`);
  });

  it('says "day" not "days" when there is exactly one', () => {
    const result = project({ window: weekly, history: history([50, 40]), now: NOW });
    expect(result.reason).toBe(`Only 1 day of history — need ${MIN_HISTORY_DAYS}`);
  });

  it('does not count today towards the minimum', () => {
    // Today is partially elapsed. Treating it as a complete day understates
    // pace every morning and overstates it every evening.
    const threeIncludingToday = history([40, 50, 60]);
    const result = project({ window: weekly, history: threeIncludingToday, now: NOW });

    expect(result.confidence).toBe('none');
    expect(result.reason).toContain('Only 2 days');
  });

  it('does not count days that have no reading for this window', () => {
    const other = history([10, 20, 30, 40], 'somethingElse');
    const result = project({ window: weekly, history: other, now: NOW });

    expect(result.reason).toBe('No history yet');
  });

  it('gets past the history gate once there are enough complete days', () => {
    const result = project({ window: weekly, history: history([40, 30, 20, 10]), now: NOW });

    expect(result.reason).not.toContain('need');
    expect(result.confidence).not.toBe('none');
    expect(result.pace).not.toBeNull();
  });

  it('projects a steady pace from a flat week', () => {
    const result = project({ window: weekly, history: FLAT_WEEK, now: NOW });

    // Ten points a day, every day: any sane weighting has to return ten.
    expect(result.pace).toBeCloseTo(10, 6);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('Based on 7 days of history');

    // 18 points left at 10 a day.
    expectAbout(result.exhaustionEstimate, NOW + 1.8 * DAY_MS);
  });

  it('does not let one spike day own the estimate, and says it is unsure', () => {
    // Five points a day, except for one forty-point afternoon mid-record.
    const spiked = history([70, 65, 60, 55, 15, 10, 5, 0]);
    const steady = history([70, 65, 60, 55, 50, 45, 40, 35]);

    const spikeResult = project({ window: weekly, history: spiked, now: NOW });
    const steadyResult = project({ window: weekly, history: steady, now: NOW });

    // A mean that let the spike dominate would land near 40 a day and predict
    // exhaustion inside half a day. The spike may bend the pace; it may not
    // become the pace.
    expect(spikeResult.pace ?? 0).toBeGreaterThan(5);
    expect(spikeResult.pace ?? 0).toBeLessThan(15);
    expect(spikeResult.exhaustionEstimate).not.toBeNull();
    expect(spikeResult.exhaustionEstimate ?? 0).toBeGreaterThan(NOW + DAY_MS);

    // Same length of record, same confidence rule — the scatter is the only
    // difference, so it has to be what moved the answer.
    expect(steadyResult.confidence).toBe('medium');
    expect(spikeResult.confidence).toBe('low');
    expect(spikeResult.reason).toBe('Usage is uneven day to day');
  });

  it('keeps a degraded confidence at low rather than dropping to none', () => {
    // 'none' means "no estimate at all"; returning it beside a number would
    // contradict itself.
    const shortAndUneven = history([50, 50, 10, 5, 0]);
    const result = project({ window: weekly, history: shortAndUneven, now: NOW });

    expect(result.confidence).toBe('low');
    expect(result.exhaustionEstimate).not.toBeNull();
  });

  it('ignores a partially elapsed today when pacing', () => {
    // Today's peak is already far above yesterday's. Counting it would treat
    // part of a day as a whole one.
    const withPartialToday = history([95, 60, 50, 40, 30, 20, 10, 0]);
    const withoutToday = withPartialToday.slice(1);

    const partial = project({ window: weekly, history: withPartialToday, now: NOW });
    const complete = project({ window: weekly, history: withoutToday, now: NOW });

    expect(partial.pace).toBe(complete.pace);
    expect(partial.exhaustionEstimate).toBe(complete.exhaustionEstimate);
    expect(partial.exhaustionEstimate ?? 0).toBeGreaterThan(NOW);
  });

  it('says nothing to warn about when the window resets first', () => {
    const early: LimitWindow = { ...weekly, utilization: 20, resetsAt: NOW + DAY_MS };
    const result = project({ window: early, history: FLAT_WEEK, now: NOW });

    // 80 points left at 10 a day is eight days away; the window rolls over
    // tomorrow. This is the healthy case and must read as reassurance.
    expect(result.exhaustionEstimate).toBeNull();
    expect(result.reason).toBe('Resets before you run out');
    // Pace is still reported even though there is no exhaustion to predict.
    expect(result.pace).toBeCloseTo(10, 6);
    expect(result.confidence).toBe('medium');
  });

  it('treats a mid-record window reset as a reset, not as usage given back', () => {
    // Peaks climb 10 a day, the window rolls over mid-record, then they climb
    // 10 a day again. Clamping that fall to zero would enter a quiet day the
    // user never had and quietly understate the pace.
    const withReset = history([45, 35, 25, 15, 30, 20, 10]);
    const withoutReset = history([70, 60, 50, 40, 30, 20, 10]);

    const reset = project({ window: weekly, history: withReset, now: NOW });
    const clean = project({ window: weekly, history: withoutReset, now: NOW });

    expect(reset.pace).toBeCloseTo(10, 6);
    expect(reset.pace).toBeCloseTo(clean.pace ?? 0, 6);
  });

  it('has nothing to say when every delta is a reset', () => {
    const alwaysResetting = history([0, 10, 20, 30]);
    const result = project({ window: weekly, history: alwaysResetting, now: NOW });

    expect(result.exhaustionEstimate).toBeNull();
    expect(result.pace).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.reason).toBe('No usable trend yet');
  });

  it('spreads a rise across a gap instead of charging it to one day', () => {
    // Days 4 and 3 are missing. The 60-point rise between day 5 and day 2
    // happened over three days, and nothing in the record says which.
    const gapped = sparseHistory({ 7: 0, 6: 10, 5: 20, 2: 80, 1: 90 });
    const result = project({ window: weekly, history: gapped, now: NOW });

    // Charged to a single day the gap reads as 60 a day and drags the pace
    // past 20; discarded entirely it leaves three identical 10s and exactly 10.
    expect(result.pace ?? 0).toBeGreaterThan(10);
    expect(result.pace ?? 0).toBeLessThan(20);
  });

  it('reports pace but no estimate when the current utilization is unknown', () => {
    // Missing is missing. Treating it as zero would promise the user a week
    // they may not have.
    const unknown: LimitWindow = { ...weekly, utilization: null };
    const result = project({ window: unknown, history: FLAT_WEEK, now: NOW });

    expect(result.exhaustionEstimate).toBeNull();
    expect(result.pace).toBeCloseTo(10, 6);
    expect(result.reason).toBe('Current usage unknown');
  });

  it('says so when the user is not consuming anything', () => {
    const idle = history([40, 40, 40, 40, 40]);
    const result = project({ window: weekly, history: idle, now: NOW });

    expect(result.exhaustionEstimate).toBeNull();
    expect(result.pace).toBe(0);
    expect(result.reason).toBe('No recent usage');
  });

  it('reports an exceeded window as already gone, whatever the number says', () => {
    // Status outranks utilization: 40% next to a composer that will not send
    // makes the extension look broken.
    const blocked: LimitWindow = { ...weekly, utilization: 40, status: 'exceeded' };
    const result = project({ window: blocked, history: FLAT_WEEK, now: NOW });

    expect(result.exhaustionEstimate).toBe(NOW);
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe('Limit already reached');
  });

  it('reports an exceeded window even with no history behind it', () => {
    // Being refused is observed, not projected, so it needs no evidence.
    const blocked: LimitWindow = { ...weekly, status: 'exceeded' };
    const result = project({ window: blocked, history: [], now: NOW });

    expect(result.exhaustionEstimate).toBe(NOW);
    expect(result.pace).toBeNull();
    expect(result.reason).toBe('Limit already reached');
  });

  it('lands the estimate at now when the window is already full', () => {
    const full: LimitWindow = { ...weekly, utilization: 100, resetsAt: null };
    const result = project({ window: full, history: FLAT_WEEK, now: NOW });

    expect(result.exhaustionEstimate).toBe(NOW);
  });

  it('still projects when the reset time is unknown', () => {
    // No reset boundary means nothing to cap against, not a reason to go quiet.
    const noReset: LimitWindow = { ...weekly, resetsAt: null };
    const result = project({ window: noReset, history: FLAT_WEEK, now: NOW });

    expectAbout(result.exhaustionEstimate, NOW + 1.8 * DAY_MS);
  });

  it('weights recent days above older ones', () => {
    // Same seven days of deltas, one accelerating and one decelerating. A flat
    // mean would call these identical.
    const accelerating = history([100, 100, 80, 65, 55, 50, 48, 47]);
    const decelerating = history([100, 100, 99, 97, 94, 79, 54, 24]);

    const rising = project({ window: weekly, history: accelerating, now: NOW });
    const falling = project({ window: weekly, history: decelerating, now: NOW });

    expect(rising.pace ?? 0).toBeGreaterThan(falling.pace ?? 0);
  });
});

describe('usableHistory', () => {
  it('excludes today and sorts oldest first', () => {
    const result = usableHistory('7d', history([99, 30, 20, 10]), NOW);

    expect(result.map((day) => day.windows['7d'])).toEqual([10, 20, 30]);
  });

  it('tolerates gaps rather than filling them with zeros', () => {
    // A day the user did not open Claude is missing evidence, not a quiet day.
    const sparse: DailyRollup[] = [
      { date: dayKey(5), windows: { '7d': 40 }, messageCount: 5, hourlyMessages: [] },
      { date: dayKey(1), windows: { '7d': 60 }, messageCount: 9, hourlyMessages: [] },
    ];

    expect(usableHistory('7d', sparse, NOW)).toHaveLength(2);
  });

  it('is not confused by unordered input', () => {
    const shuffled = [...history([99, 30, 20, 10])].reverse();
    expect(usableHistory('7d', shuffled, NOW).map((d) => d.date)).toEqual([
      dayKey(3),
      dayKey(2),
      dayKey(1),
    ]);
  });
});

describe('confidenceFor', () => {
  it('reports none below the minimum', () => {
    expect(confidenceFor(0)).toBe('none');
    expect(confidenceFor(MIN_HISTORY_DAYS - 1)).toBe('none');
  });

  it('climbs with the length of the record', () => {
    expect(confidenceFor(MIN_HISTORY_DAYS)).toBe('low');
    expect(confidenceFor(FULL_CONFIDENCE_DAYS)).toBe('medium');
    expect(confidenceFor(FULL_CONFIDENCE_DAYS * 2)).toBe('high');
  });
});

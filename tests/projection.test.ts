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

const weekly: LimitWindow = {
  key: '7d',
  label: 'Weekly',
  shortLabel: 'Weekly',
  utilization: 82,
  status: 'ok',
  resetsAt: NOW + 3 * DAY_MS,
  active: true,
};

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
    const result = project({ window: weekly, history: history([40, 50, 60, 70]), now: NOW });

    // The estimate itself is M4. What matters here is that the gate opened and
    // the reason changed.
    expect(result.reason).not.toContain('need');
    expect(result.reason).toBe('Projection not implemented yet');
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

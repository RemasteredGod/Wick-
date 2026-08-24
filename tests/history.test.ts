import { describe, expect, it } from 'vitest';
import { averageMessagesPerDay, messagesToday, peakHour } from '~/core/history';
import type { DailyRollup } from '~/core/types';

const NOW = new Date(2026, 7, 24, 14, 0).getTime();
const DAY_MS = 86_400_000;

function dayKey(offsetDays: number): string {
  const d = new Date(NOW - offsetDays * DAY_MS);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** `hours` maps hour-of-day to a count; everything else is zero. */
function rollup(
  offsetDays: number,
  messageCount: number,
  hours: Record<number, number> = {},
): DailyRollup {
  const hourlyMessages = new Array<number>(24).fill(0);
  for (const [hour, count] of Object.entries(hours)) {
    hourlyMessages[Number(hour)] = count;
  }
  return { date: dayKey(offsetDays), windows: {}, messageCount, hourlyMessages };
}

describe('messagesToday', () => {
  it('reads today out of the record', () => {
    const record = [rollup(2, 5), rollup(1, 9), rollup(0, 17)];
    expect(messagesToday(record, NOW)).toBe(17);
  });

  it('is null when today has no rollup, not zero', () => {
    // "Nothing recorded" and "nothing sent" are different claims, and only one
    // of them is true before the first poll of the day.
    expect(messagesToday([rollup(1, 9)], NOW)).toBeNull();
    expect(messagesToday([], NOW)).toBeNull();
  });

  it('reports a real zero as zero', () => {
    // A rollup exists, so Wick was watching and saw nothing sent.
    expect(messagesToday([rollup(0, 0)], NOW)).toBe(0);
  });

  it('is not fooled by a rollup from a neighbouring day', () => {
    expect(messagesToday([rollup(1, 40)], NOW)).toBeNull();
  });
});

describe('averageMessagesPerDay', () => {
  it('averages complete days', () => {
    const record = [rollup(3, 10), rollup(2, 20), rollup(1, 30)];
    expect(averageMessagesPerDay(record, NOW)).toBe(20);
  });

  it('excludes today, however busy or quiet it has been so far', () => {
    const past = [rollup(3, 10), rollup(2, 20), rollup(1, 30)];
    const quietMorning = averageMessagesPerDay([...past, rollup(0, 1)], NOW);
    const heavyDay = averageMessagesPerDay([...past, rollup(0, 400)], NOW);

    // Otherwise the mean sags every morning and climbs every evening without
    // the user's habit changing at all.
    expect(quietMorning).toBe(20);
    expect(heavyDay).toBe(20);
  });

  it('is null when there are no complete days', () => {
    expect(averageMessagesPerDay([rollup(0, 12)], NOW)).toBeNull();
    expect(averageMessagesPerDay([], NOW)).toBeNull();
  });

  it('counts a recorded quiet day rather than skipping it', () => {
    // Days the user did not open Claude are absent from the record; a day that
    // is present with a zero was observed and belongs in the mean.
    expect(averageMessagesPerDay([rollup(2, 0), rollup(1, 10)], NOW)).toBe(5);
  });

  it('rounds to one decimal place', () => {
    const record = [rollup(3, 10), rollup(2, 10), rollup(1, 11)];
    expect(averageMessagesPerDay(record, NOW)).toBe(10.3);
  });
});

describe('peakHour', () => {
  it('finds the busiest hour summed across the whole record', () => {
    // No single day picks 15; only the total does.
    const record = [
      rollup(2, 12, { 9: 5, 15: 4 }),
      rollup(1, 12, { 9: 2, 15: 6 }),
      rollup(0, 12, { 9: 1, 15: 5 }),
    ];
    expect(peakHour(record)).toBe(15);
  });

  it('counts today too', () => {
    const record = [rollup(1, 3, { 8: 3 }), rollup(0, 9, { 22: 9 })];
    expect(peakHour(record)).toBe(22);
  });

  it('is null when nothing is logged, not zero', () => {
    // Hour zero is midnight, and midnight is a real answer — so an empty
    // record cannot be allowed to look like one.
    expect(peakHour([])).toBeNull();
    expect(peakHour([rollup(1, 0)])).toBeNull();
  });

  it('reports midnight when midnight is genuinely the peak', () => {
    expect(peakHour([rollup(1, 4, { 0: 4, 13: 1 })])).toBe(0);
  });

  it('breaks ties towards the earlier hour', () => {
    expect(peakHour([rollup(1, 6, { 7: 3, 19: 3 })])).toBe(7);
  });

  it('tolerates rollups written before hourly counts existed', () => {
    const legacy: DailyRollup = {
      date: dayKey(2),
      windows: {},
      messageCount: 30,
      hourlyMessages: [],
    };
    expect(peakHour([legacy, rollup(1, 2, { 11: 2 })])).toBe(11);
    expect(peakHour([legacy])).toBeNull();
  });
});

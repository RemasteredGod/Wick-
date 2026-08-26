import { describe, expect, it } from 'vitest';
import { isDay, weekStart, monthStart, inPeriod, daysBetween } from '../leaderboard/periods';
import { readSubmission, MAX_MESSAGES } from '../leaderboard/submission';
import type { DailyRow } from '../leaderboard/submission';
import {
  board,
  place,
  rankedTotal,
  standingFor,
  streak,
  summarise,
  type Participant,
  type Standing,
} from '../leaderboard/ranking';

/* ---- periods -------------------------------------------------------------- */

describe('periods', () => {
  it('accepts real days and rejects impossible ones', () => {
    expect(isDay('2026-08-25')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('2026-8-25')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(isDay(20260825)).toBe(false);
  });

  it('folds a week back to its Monday, with Sunday ending the week', () => {
    // 2026-08-24 is a Monday.
    expect(weekStart('2026-08-24')).toBe('2026-08-24');
    expect(weekStart('2026-08-25')).toBe('2026-08-24');
    // Sunday belongs to the week that started six days earlier, not the next one.
    expect(weekStart('2026-08-30')).toBe('2026-08-24');
    expect(weekStart('2026-08-31')).toBe('2026-08-31');
  });

  it('crosses month and year boundaries within a week', () => {
    expect(weekStart('2026-01-01')).toBe('2025-12-29');
    expect(monthStart('2026-08-25')).toBe('2026-08-01');
  });

  it('scopes days to a board', () => {
    const today = '2026-08-25';
    expect(inPeriod('2026-08-24', 'week', today)).toBe(true);
    expect(inPeriod('2026-08-23', 'week', today)).toBe(false); // previous Sunday
    expect(inPeriod('2026-08-01', 'month', today)).toBe(true);
    expect(inPeriod('2026-07-31', 'month', today)).toBe(false);
    expect(inPeriod('2019-01-01', 'all', today)).toBe(true);
  });

  it('counts days between, in both directions', () => {
    expect(daysBetween('2026-08-24', '2026-08-25')).toBe(1);
    expect(daysBetween('2026-08-25', '2026-08-24')).toBe(-1);
    // Across a DST boundary in most zones — must still be whole days, because
    // these are plain dates rather than instants.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });
});

/* ---- submission ----------------------------------------------------------- */

const validBody = { day: '2026-08-25', messages: 42 };

describe('submission', () => {
  it('reads a day and a count, and nothing else', () => {
    const result = readSubmission(validBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.row).toEqual({ day: '2026-08-25', messages: 42 });
  });

  it('keeps no field the body carried beyond the two it reads', () => {
    // A body written against a different version must not smuggle anything
    // through. The rollup the extension submits from also holds an account id,
    // an hourly breakdown and per-window percentages; none may survive.
    const result = readSubmission({
      ...validBody,
      accountId: 'org-123',
      hourlyMessages: [1, 2, 3],
      windows: { '7d': 82 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.row).sort()).toEqual(['day', 'messages']);
    expect(JSON.stringify(result.row)).not.toContain('org-123');
  });

  it('never substitutes zero for an unreadable count', () => {
    // ADR 0005: a count the record does not provide is unknown, not zero. A
    // missing count must not survive as a row with messages: 0.
    expect(readSubmission({ day: '2026-08-25' })).toEqual({
      ok: false,
      rejection: 'bad-messages',
    });
    expect(readSubmission({ day: '2026-08-25', messages: null })).toEqual({
      ok: false,
      rejection: 'bad-messages',
    });
  });

  it('refuses counts that are not non-negative safe integers', () => {
    const bad = [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5'];
    for (const value of bad) {
      expect(
        readSubmission({ day: '2026-08-25', messages: value }),
        `messages ${String(value)} should be refused`,
      ).toEqual({ ok: false, rejection: 'bad-messages' });
    }
  });

  it('accepts a zero the extension actually measured', () => {
    // Distinct from the case above: a day on which nothing was sent is a real
    // observation, and refusing it would put a hole in a streak.
    expect(readSubmission({ day: '2026-08-25', messages: 0 })).toEqual({
      ok: true,
      row: { day: '2026-08-25', messages: 0 },
    });
  });

  it('applies the sanity ceiling', () => {
    expect(readSubmission({ ...validBody, messages: MAX_MESSAGES })).toEqual({
      ok: true,
      row: { day: '2026-08-25', messages: MAX_MESSAGES },
    });
    expect(readSubmission({ ...validBody, messages: MAX_MESSAGES + 1 })).toEqual({
      ok: false,
      rejection: 'implausible',
    });
  });

  it('refuses a bad day and a non-object body', () => {
    expect(readSubmission({ ...validBody, day: '25-08-2026' })).toEqual({
      ok: false,
      rejection: 'bad-day',
    });
    expect(readSubmission(null)).toEqual({ ok: false, rejection: 'malformed' });
    expect(readSubmission('nope')).toEqual({ ok: false, rejection: 'malformed' });
  });
});

/* ---- ranking -------------------------------------------------------------- */

function row(day: string, messages: number): DailyRow {
  return { day, messages };
}

function standing(name: string, ranked: number): Standing {
  return { rank: 0, name, ranked, days: 1, lastDay: null };
}

describe('ranking', () => {
  it('scores the message count, summed over the rows', () => {
    expect(rankedTotal([row('2026-08-24', 10), row('2026-08-25', 20)])).toBe(30);
    expect(rankedTotal([])).toBe(0);
  });

  it('counts distinct days, not rows, alongside the score', () => {
    // The store upserts by day so a duplicate should not reach here — but
    // `days` is displayed beside the total, and inflating it would make a busy
    // afternoon read as a busy week.
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-08-24', 10), row('2026-08-24', 10), row('2026-08-25', 5)],
    };
    const result = summarise(participant, 'all', '2026-08-25');
    expect(result.days).toBe(2);
    expect(result.ranked).toBe(25);
  });

  it('does not order by days', () => {
    // Steady beats sporadic only if it sent more. Seven light days must not
    // outrank one heavy one — `days` is context, never part of the comparison.
    const steady: Participant = {
      name: 'steady',
      rows: Array.from({ length: 7 }, (_, i) => row(`2026-08-2${String(i + 1)}`, 10)),
    };
    const burst: Participant = { name: 'burst', rows: [row('2026-08-25', 500)] };

    const result = board([steady, burst], 'all', '2026-08-25');
    expect(result[0]?.name).toBe('burst');
    expect(result[0]?.days).toBe(1);
    expect(result[1]?.days).toBe(7);
  });

  it('shares a rank on a tie and skips the next, 1-2-2-4', () => {
    const placed = place([
      standing('a', 100),
      standing('b', 90),
      standing('c', 90),
      standing('d', 80),
    ]);
    expect(placed.map((s) => s.rank)).toEqual([1, 2, 2, 4]);
  });

  it('breaks ties by name so order is stable across requests', () => {
    const forward = place([standing('zeta', 50), standing('alpha', 50)]);
    const backward = place([standing('alpha', 50), standing('zeta', 50)]);
    expect(forward.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(backward.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('scopes a summary to its period', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-08-25', 100), row('2026-08-20', 500), row('2026-07-01', 900)],
    };

    expect(summarise(participant, 'week', '2026-08-25').ranked).toBe(100);
    expect(summarise(participant, 'month', '2026-08-25').ranked).toBe(600);
    expect(summarise(participant, 'all', '2026-08-25').ranked).toBe(1_500);
  });

  it('reports the most recent day within the period, not overall', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-08-25', 10), row('2026-08-20', 10)],
    };
    expect(summarise(participant, 'week', '2026-08-25').lastDay).toBe('2026-08-25');
    expect(summarise(participant, 'month', '2026-08-25').lastDay).toBe('2026-08-25');
  });

  it('leaves rank at zero until a standing is placed', () => {
    const only: Participant = { name: 'ash', rows: [row('2026-08-25', 2)] };
    expect(summarise(only, 'all', '2026-08-25').rank).toBe(0);
  });

  it('drops participants with nothing in the period rather than ranking a zero', () => {
    const active: Participant = { name: 'active', rows: [row('2026-08-25', 20)] };
    const dormant: Participant = { name: 'dormant', rows: [row('2025-01-01', 20)] };

    const result = board([active, dormant], 'week', '2026-08-25');
    expect(result.map((s) => s.name)).toEqual(['active']);
  });

  it('drops a participant whose only days in the period were empty', () => {
    // A measured zero is a legitimate row, but a zero total is not a standing:
    // it would occupy a place somebody else earned.
    const quiet: Participant = { name: 'quiet', rows: [row('2026-08-25', 0)] };
    expect(board([quiet], 'week', '2026-08-25')).toEqual([]);
  });

  it('honours the board size', () => {
    const many: Participant[] = Array.from({ length: 150 }, (_, index) => ({
      name: `p${String(index).padStart(3, '0')}`,
      rows: [row('2026-08-25', 1_000 - index)],
    }));

    expect(board(many, 'all', '2026-08-25').length).toBe(100);
    expect(board(many, 'all', '2026-08-25', 10).length).toBe(10);
  });

  it('finds a rank below the published slice', () => {
    const many: Participant[] = Array.from({ length: 150 }, (_, index) => ({
      name: `p${String(index).padStart(3, '0')}`,
      rows: [row('2026-08-25', 1_000 - index)],
    }));

    // p120 is far outside the top 100 and still has a real rank.
    const found = standingFor(many, 'p120', 'all', '2026-08-25');
    expect(found?.rank).toBe(121);
    expect(board(many, 'all', '2026-08-25').some((s) => s.name === 'p120')).toBe(false);
  });

  it('returns null for a name with nothing in the period', () => {
    const one: Participant = { name: 'ash', rows: [row('2025-01-01', 10)] };
    expect(standingFor([one], 'ash', 'week', '2026-08-25')).toBeNull();
    expect(standingFor([one], 'nobody', 'all', '2026-08-25')).toBeNull();
  });

  it('counts a streak of consecutive days, across a month boundary', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-07-30', 1), row('2026-07-31', 1), row('2026-08-01', 1)],
    };
    expect(streak(participant)).toBe(3);
  });

  it('breaks a streak on a gap and counts only the run ending at the last day', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-08-01', 1), row('2026-08-02', 1), row('2026-08-20', 1)],
    };
    expect(streak(participant)).toBe(1);
    expect(streak({ name: 'empty', rows: [] })).toBe(0);
  });
});

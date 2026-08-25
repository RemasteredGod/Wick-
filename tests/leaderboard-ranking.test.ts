import { describe, expect, it } from 'vitest';
import { isDay, weekStart, monthStart, inPeriod, daysBetween } from '../leaderboard/periods';
import { readSubmission, MAX_FAMILIES, MAX_SESSIONS } from '../leaderboard/submission';
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

const validBody = {
  day: '2026-08-25',
  sessions: 4,
  families: {
    opus: { input: 100, output: 200, cacheCreation: 50, cacheRead: 9_000 },
    sonnet: { input: 10, output: 20, cacheCreation: 5, cacheRead: 900 },
  },
};

describe('submission', () => {
  it('sums families into one row and keeps no family labels', () => {
    const result = readSubmission(validBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.row).toEqual({
      day: '2026-08-25',
      sessions: 4,
      counters: { input: 110, output: 220, cacheCreation: 55, cacheRead: 9_900 },
    });
    expect(JSON.stringify(result.row)).not.toContain('opus');
  });

  it('rejects the whole submission when one family is missing a counter', () => {
    const body = {
      ...validBody,
      families: {
        opus: { input: 100, output: 200, cacheCreation: 50, cacheRead: 9_000 },
        sonnet: { input: 10, output: 20, cacheCreation: 5 },
      },
    };

    const result = readSubmission(body);
    expect(result).toEqual({ ok: false, rejection: 'bad-counters' });
  });

  it('never substitutes zero for an unreadable counter', () => {
    // ADR 0005: a count the record does not provide is unknown, not zero. The
    // partial family must not survive as a row with cacheRead: 0.
    const result = readSubmission({
      day: '2026-08-25',
      sessions: 1,
      families: { opus: { input: 1, output: 1, cacheCreation: 1, cacheRead: null } },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses counters that are not non-negative safe integers', () => {
    const bad = [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5'];
    for (const value of bad) {
      const result = readSubmission({
        day: '2026-08-25',
        sessions: 1,
        families: { opus: { input: value, output: 1, cacheCreation: 1, cacheRead: 1 } },
      });
      expect(result, `input ${String(value)} should be refused`).toEqual({
        ok: false,
        rejection: 'bad-counters',
      });
    }
  });

  it('applies the sanity ceilings', () => {
    expect(readSubmission({ ...validBody, sessions: MAX_SESSIONS + 1 })).toEqual({
      ok: false,
      rejection: 'implausible',
    });

    const families: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_FAMILIES; index += 1) {
      families[`m${index}`] = { input: 1, output: 1, cacheCreation: 1, cacheRead: 1 };
    }
    expect(readSubmission({ ...validBody, families })).toEqual({
      ok: false,
      rejection: 'too-many-families',
    });
  });

  it('refuses a bad day, an empty family map, and a non-object body', () => {
    expect(readSubmission({ ...validBody, day: '25-08-2026' })).toEqual({
      ok: false,
      rejection: 'bad-day',
    });
    expect(readSubmission({ ...validBody, families: {} })).toEqual({
      ok: false,
      rejection: 'bad-counters',
    });
    expect(readSubmission(null)).toEqual({ ok: false, rejection: 'malformed' });
    expect(readSubmission('nope')).toEqual({ ok: false, rejection: 'malformed' });
  });
});

/* ---- ranking -------------------------------------------------------------- */

function row(day: string, input: number, output: number, cacheCreation = 0, cacheRead = 0): DailyRow {
  return { day, sessions: 1, counters: { input, output, cacheCreation, cacheRead } };
}

function standing(name: string, ranked: number): Standing {
  return {
    rank: 0,
    name,
    ranked,
    counters: { input: ranked, output: 0, cacheCreation: 0, cacheRead: 0 },
    sessions: 0,
    lastDay: null,
  };
}

describe('ranking', () => {
  it('excludes both cache figures from the score', () => {
    // ADR 0006: the score is input + output. plan.md §4 recommends folding
    // cache creation in; the ADR is the accepted decision and does not.
    expect(rankedTotal({ input: 10, output: 20, cacheCreation: 5, cacheRead: 1_000_000 })).toBe(30);
    expect(rankedTotal({ input: 10, output: 20, cacheCreation: 9_999, cacheRead: 0 })).toBe(30);
  });

  it('does not let a cache-heavy workflow outrank real work', () => {
    // The exact failure ADR 0006 names: whoever has the most cache reads must
    // not win on a raw sum.
    const cacheHeavy: Participant = {
      name: 'cache-heavy',
      rows: [row('2026-08-25', 10, 10, 0, 5_000_000)],
    };
    const worker: Participant = { name: 'worker', rows: [row('2026-08-25', 900, 900)] };

    const result = board([cacheHeavy, worker], 'all', '2026-08-25');
    expect(result[0]?.name).toBe('worker');
    expect(result[1]?.name).toBe('cache-heavy');
    // The cache figure is still carried, just not summed.
    expect(result[1]?.counters.cacheRead).toBe(5_000_000);
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
      rows: [row('2026-08-25', 100, 0), row('2026-08-20', 500, 0), row('2026-07-01', 900, 0)],
    };

    expect(summarise(participant, 'week', '2026-08-25').ranked).toBe(100);
    expect(summarise(participant, 'month', '2026-08-25').ranked).toBe(600);
    expect(summarise(participant, 'all', '2026-08-25').ranked).toBe(1_500);
  });

  it('leaves rank at zero until a standing is placed', () => {
    const only: Participant = { name: 'ash', rows: [row('2026-08-25', 1, 1)] };
    expect(summarise(only, 'all', '2026-08-25').rank).toBe(0);
  });

  it('drops participants with nothing in the period rather than ranking a zero', () => {
    const active: Participant = { name: 'active', rows: [row('2026-08-25', 10, 10)] };
    const dormant: Participant = { name: 'dormant', rows: [row('2025-01-01', 10, 10)] };

    const result = board([active, dormant], 'week', '2026-08-25');
    expect(result.map((s) => s.name)).toEqual(['active']);
  });

  it('honours the board size', () => {
    const many: Participant[] = Array.from({ length: 150 }, (_, index) => ({
      name: `p${String(index).padStart(3, '0')}`,
      rows: [row('2026-08-25', 1_000 - index, 0)],
    }));

    expect(board(many, 'all', '2026-08-25').length).toBe(100);
    expect(board(many, 'all', '2026-08-25', 10).length).toBe(10);
  });

  it('finds a rank below the published slice', () => {
    const many: Participant[] = Array.from({ length: 150 }, (_, index) => ({
      name: `p${String(index).padStart(3, '0')}`,
      rows: [row('2026-08-25', 1_000 - index, 0)],
    }));

    // p120 is far outside the top 100 and still has a real rank.
    const found = standingFor(many, 'p120', 'all', '2026-08-25');
    expect(found?.rank).toBe(121);
    expect(board(many, 'all', '2026-08-25').some((s) => s.name === 'p120')).toBe(false);
  });

  it('returns null for a name with nothing in the period', () => {
    const one: Participant = { name: 'ash', rows: [row('2025-01-01', 5, 5)] };
    expect(standingFor([one], 'ash', 'week', '2026-08-25')).toBeNull();
    expect(standingFor([one], 'nobody', 'all', '2026-08-25')).toBeNull();
  });

  it('counts a streak of consecutive days, across a month boundary', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-07-30', 1, 1), row('2026-07-31', 1, 1), row('2026-08-01', 1, 1)],
    };
    expect(streak(participant)).toBe(3);
  });

  it('breaks a streak on a gap and counts only the run ending at the last day', () => {
    const participant: Participant = {
      name: 'ash',
      rows: [row('2026-08-01', 1, 1), row('2026-08-02', 1, 1), row('2026-08-20', 1, 1)],
    };
    expect(streak(participant)).toBe(1);
    expect(streak({ name: 'empty', rows: [] })).toBe(0);
  });
});

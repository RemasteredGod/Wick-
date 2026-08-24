import { describe, expect, it } from 'vitest';
import {
  field,
  localDateKey,
  normaliseResetsAt,
  normaliseStatus,
  normaliseUtilization,
  parseMaybeJson,
  thresholdState,
} from '~/core/normalise';

describe('normaliseResetsAt', () => {
  it('reads the ISO strings the usage endpoint sends', () => {
    expect(normaliseResetsAt('2026-08-27T09:00:00Z')).toBe(Date.parse('2026-08-27T09:00:00Z'));
  });

  it('reads the unix seconds the completion stream sends', () => {
    const seconds = 1_787_000_000;
    expect(normaliseResetsAt(seconds)).toBe(seconds * 1000);
  });

  it('leaves milliseconds alone', () => {
    const ms = 1_787_000_000_000;
    expect(normaliseResetsAt(ms)).toBe(ms);
  });

  it('agrees with itself across both representations of one moment', () => {
    const iso = '2026-08-27T09:00:00.000Z';
    const seconds = Date.parse(iso) / 1000;
    expect(normaliseResetsAt(seconds)).toBe(normaliseResetsAt(iso));
  });

  it('accepts a timestamp that arrived as a string', () => {
    expect(normaliseResetsAt('1787000000')).toBe(1_787_000_000_000);
  });

  it.each([undefined, null, '', '   ', 'next Tuesday', 0, -1, NaN, {}, []])(
    'returns null rather than guessing for %p',
    (input) => {
      expect(normaliseResetsAt(input)).toBeNull();
    },
  );

  it('rejects timestamps outside a plausible range', () => {
    expect(normaliseResetsAt(42)).toBeNull();
  });
});

describe('normaliseUtilization', () => {
  it('passes through the integer percent from the usage endpoint', () => {
    expect(normaliseUtilization(82, 'percent')).toBe(82);
  });

  it('scales the 0-1 float from the stream', () => {
    expect(normaliseUtilization(0.82, 'fraction')).toBe(82);
  });

  it('does not confuse the two scales', () => {
    // 1 means 1% on one wire and 100% on the other. The caller says which.
    expect(normaliseUtilization(1, 'percent')).toBe(1);
    expect(normaliseUtilization(1, 'fraction')).toBe(100);
  });

  it('clamps overage past 100 rather than inventing a number', () => {
    expect(normaliseUtilization(1.4, 'fraction')).toBe(100);
  });

  it('returns null for a missing field, never zero', () => {
    expect(normaliseUtilization(undefined, 'percent')).toBeNull();
    expect(normaliseUtilization(null, 'fraction')).toBeNull();
    expect(normaliseUtilization('unavailable', 'percent')).toBeNull();
  });

  it('distinguishes an honest zero from a missing value', () => {
    expect(normaliseUtilization(0, 'percent')).toBe(0);
  });
});

describe('normaliseStatus', () => {
  it.each(['exceeded_limit', 'limit_reached', 'BLOCKED'])('reads %s as exceeded', (input) => {
    expect(normaliseStatus(input)).toBe('exceeded');
  });

  it.each(['approaching_limit', 'warning', 'near_limit'])('reads %s as approaching', (input) => {
    expect(normaliseStatus(input)).toBe('approaching');
  });

  it('reads the healthy spellings as ok', () => {
    expect(normaliseStatus('ok')).toBe('ok');
    expect(normaliseStatus('within_limit')).toBe('ok');
  });

  it('calls an unrecognised status unknown rather than ok', () => {
    // When claude.ai invents a new status, saying so beats reporting all clear.
    expect(normaliseStatus('some_new_thing')).toBe('unknown');
    expect(normaliseStatus(undefined)).toBe('unknown');
    expect(normaliseStatus(42)).toBe('unknown');
  });
});

describe('thresholdState', () => {
  it('follows the bands when the status agrees', () => {
    expect(thresholdState(12, 'ok')).toBe('ok');
    expect(thresholdState(69.9, 'ok')).toBe('ok');
    expect(thresholdState(70, 'ok')).toBe('warn');
    expect(thresholdState(82, 'ok')).toBe('warn');
    expect(thresholdState(90, 'ok')).toBe('warn');
    expect(thresholdState(90.1, 'ok')).toBe('crit');
  });

  it('lets status win at the boundary', () => {
    // A window can report under 100% while already refusing sends. Showing 98%
    // beside a composer that will not send makes the extension look broken.
    expect(thresholdState(98, 'exceeded')).toBe('crit');
    expect(thresholdState(12, 'exceeded')).toBe('crit');
  });

  it('escalates a comfortable number the provider has flagged', () => {
    expect(thresholdState(40, 'approaching')).toBe('warn');
  });

  it('reports unknown rather than ok when there is no number', () => {
    expect(thresholdState(null, 'unknown')).toBe('unknown');
    expect(thresholdState(null, 'ok')).toBe('unknown');
  });

  it('still warns with no number when the provider flagged the window', () => {
    expect(thresholdState(null, 'approaching')).toBe('warn');
  });
});

describe('field', () => {
  it('reads a property without caring what it was handed', () => {
    expect(field({ a: 1 }, 'a')).toBe(1);
    expect(field(null, 'a')).toBeUndefined();
    expect(field('a string', 'a')).toBeUndefined();
    expect(field(undefined, 'a')).toBeUndefined();
  });
});

describe('parseMaybeJson', () => {
  it('unwraps the double encoding refusal responses use', () => {
    const inner = JSON.stringify({ type: 'message_limit' });
    expect(parseMaybeJson(JSON.stringify(inner))).toEqual({ type: 'message_limit' });
  });

  it('returns a plain string unchanged rather than throwing', () => {
    expect(parseMaybeJson('not json at all')).toBe('not json at all');
  });
});

describe('localDateKey', () => {
  it('formats a local calendar date', () => {
    const at = new Date(2026, 7, 24, 23, 30).getTime();
    expect(localDateKey(at)).toBe('2026-08-24');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

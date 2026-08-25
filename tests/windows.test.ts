/**
 * Selection and merging — the two rules that decide what the panel shows.
 *
 * Both used to be implicit and both were wrong in ways nothing could catch:
 * "the weekly window is the second one in the array" is a promise claude.ai
 * never made, and "the newest reading is the whole truth" deletes a free plan's
 * only numbers every time the usage endpoint answers with an empty list.
 *
 * These are pure functions over plain objects, so this file needs no chrome
 * mock, no storage, and no clock beyond the `now` it passes in.
 */

import { describe, expect, it } from 'vitest';
import {
  WINDOW_STALE_MS,
  allowanceWindow,
  mergeReading,
  orderWindows,
  sessionWindow,
  type Reading,
} from '~/core/windows';
import type { LimitWindow, Snapshot, WindowRole } from '~/core/types';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function window(patch: Partial<LimitWindow> & { key: string; role: WindowRole }): LimitWindow {
  return {
    label: patch.key,
    shortLabel: patch.key,
    utilization: 10,
    status: 'ok',
    resetsAt: NOW + DAY,
    active: true,
    ...patch,
  };
}

const session = (patch: Partial<LimitWindow> = {}) =>
  window({ key: '5h', role: 'session', resetsAt: NOW + 2 * HOUR, ...patch });
const weekly = (patch: Partial<LimitWindow> = {}) =>
  window({ key: '7d', role: 'weekly', resetsAt: NOW + 4 * DAY, ...patch });
const opus = (patch: Partial<LimitWindow> = {}) =>
  window({ key: '7d_oi', role: 'weekly-model', resetsAt: NOW + 4 * DAY, ...patch });

function reading(patch: Partial<Reading> & { windows: LimitWindow[] }): Reading {
  return { providerId: 'claude', accountId: 'org-1', source: 'usage', at: NOW, ...patch };
}

function snapshot(windows: LimitWindow[], patch: Partial<Snapshot> = {}): Snapshot {
  return {
    providerId: 'claude',
    accountId: 'org-1',
    windows,
    fetchedAt: NOW - HOUR,
    source: 'usage',
    ...patch,
  };
}

/* ---- Selection ----------------------------------------------------------- */

describe('allowanceWindow', () => {
  it('finds the weekly window wherever the provider listed it', () => {
    const listed = [weekly(), session(), opus()];
    expect(allowanceWindow(listed)?.key).toBe('7d');
  });

  it('does not depend on array order', () => {
    const forward = [session(), weekly()];
    const backward = [weekly(), session()];
    expect(allowanceWindow(forward)?.key).toBe(allowanceWindow(backward)?.key);
  });

  it('picks the most constrained model weekly when there is no account-wide one', () => {
    const sonnet = window({ key: '7d:sonnet', role: 'weekly-model', utilization: 30 });
    const bound = window({ key: '7d:opus', role: 'weekly-model', utilization: 91 });

    expect(allowanceWindow([session(), sonnet, bound])?.key).toBe('7d:opus');
  });

  it('falls back to the window that resets furthest out when nothing is classified', () => {
    const untagged = [
      window({ key: 'a', role: 'other', resetsAt: NOW + HOUR }),
      window({ key: 'b', role: 'other', resetsAt: NOW + 5 * DAY }),
    ];
    expect(allowanceWindow(untagged)?.key).toBe('b');
  });

  it('is null when there is nothing to choose from', () => {
    expect(allowanceWindow([])).toBeNull();
  });
});

describe('sessionWindow', () => {
  it('prefers the tagged session over the one that resets soonest', () => {
    const tagged = session({ resetsAt: NOW + 3 * DAY });
    expect(sessionWindow([weekly(), tagged])?.key).toBe('5h');
  });

  it('falls back to the soonest reset', () => {
    const soon = window({ key: 'a', role: 'other', resetsAt: NOW + HOUR });
    const later = window({ key: 'b', role: 'other', resetsAt: NOW + DAY });
    expect(sessionWindow([later, soon])?.key).toBe('a');
  });
});

describe('orderWindows', () => {
  it('puts the session first and the allowance second, whatever the input order', () => {
    const ordered = orderWindows([opus(), weekly(), session()]);
    expect(ordered.map((w) => w.key)).toEqual(['5h', '7d', '7d_oi']);
  });
});

/* ---- Merging ------------------------------------------------------------- */

describe('mergeReading', () => {
  it('stamps every window with where it came from and when', () => {
    const merged = mergeReading(null, reading({ windows: [session()], source: 'stream' }), NOW);

    expect(merged?.windows[0]).toMatchObject({ source: 'stream', observedAt: NOW });
  });

  it('lets a non-empty authoritative reading replace everything', () => {
    const existing = snapshot([session({ utilization: 90 }), weekly({ utilization: 90 })], {
      source: 'stream',
    });

    const merged = mergeReading(
      existing,
      reading({ windows: [session({ utilization: 12 })], at: NOW }),
      NOW,
    );

    // The endpoint lists every window the account has. One entry means one
    // window, not "one window changed".
    expect(merged?.windows.map((w) => w.key)).toEqual(['5h']);
    expect(merged?.windows[0]?.utilization).toBe(12);
  });

  it('does not let an empty authoritative reading erase a stream reading', () => {
    // The free-plan case: /usage answers, and lists nothing at all.
    const existing = snapshot([session({ utilization: 44 })], { source: 'stream' });

    const merged = mergeReading(existing, reading({ windows: [], at: NOW }), NOW);

    expect(merged?.windows.map((w) => w.key)).toEqual(['5h']);
    expect(merged?.windows[0]?.utilization).toBe(44);
  });

  it('writes an empty snapshot when an empty authoritative reading is all there is', () => {
    const merged = mergeReading(null, reading({ windows: [], at: NOW }), NOW);
    expect(merged?.windows).toEqual([]);
  });

  it('lets a refusal update one window without deleting the others', () => {
    const existing = snapshot([
      session({ utilization: 80, observedAt: NOW - HOUR, source: 'usage' }),
      weekly({ utilization: 50, observedAt: NOW - HOUR, source: 'usage' }),
    ]);

    const merged = mergeReading(
      existing,
      reading({
        windows: [session({ utilization: 100, status: 'exceeded' })],
        source: 'rejection',
        at: NOW,
      }),
      NOW,
    );

    expect(merged?.windows.map((w) => w.key)).toEqual(['5h', '7d']);
    expect(merged?.windows[0]).toMatchObject({ status: 'exceeded', source: 'rejection' });
    expect(merged?.windows[1]).toMatchObject({ utilization: 50, source: 'usage' });
  });

  it('refuses a stream reading older than the window already stored', () => {
    const existing = snapshot([session({ utilization: 60, observedAt: NOW, source: 'usage' })]);

    const merged = mergeReading(
      existing,
      reading({
        windows: [session({ utilization: 99 })],
        source: 'stream',
        at: NOW - 1_000,
      }),
      NOW,
    );

    expect(merged).toBeNull();
  });

  it('prefers the more trustworthy reading when two land in the same millisecond', () => {
    const existing = snapshot([session({ utilization: 60, observedAt: NOW, source: 'usage' })]);

    const merged = mergeReading(
      existing,
      reading({ windows: [session({ utilization: 99 })], source: 'stream', at: NOW }),
      NOW,
    );

    expect(merged).toBeNull();
  });

  it('replaces everything when the account changes', () => {
    const existing = snapshot([session({ utilization: 90 }), weekly({ utilization: 90 })]);

    const merged = mergeReading(
      existing,
      reading({ accountId: 'org-2', windows: [session({ utilization: 5 })], at: NOW }),
      NOW,
    );

    expect(merged?.accountId).toBe('org-2');
    expect(merged?.windows.map((w) => w.key)).toEqual(['5h']);
    expect(merged?.windows[0]?.utilization).toBe(5);
  });

  it('does not carry forward a window whose cycle has ended', () => {
    const existing = snapshot([
      session({ resetsAt: NOW - 1_000, utilization: 99 }),
      weekly({ utilization: 40 }),
    ]);

    const merged = mergeReading(
      existing,
      reading({ windows: [weekly({ utilization: 41 })], source: 'stream', at: NOW }),
      NOW,
    );

    expect(merged?.windows.map((w) => w.key)).toEqual(['7d']);
  });

  it('drops a window with no reset time once it has gone stale', () => {
    const existing = snapshot([
      window({ key: 'x', role: 'other', resetsAt: null, observedAt: NOW - WINDOW_STALE_MS - 1 }),
      weekly(),
    ]);

    const merged = mergeReading(
      existing,
      reading({ windows: [weekly({ utilization: 44 })], source: 'stream', at: NOW }),
      NOW,
    );

    expect(merged?.windows.map((w) => w.key)).toEqual(['7d']);
  });

  it('is silent when an optimistic reading says nothing new', () => {
    const existing = snapshot([session({ utilization: 44, observedAt: NOW - HOUR })]);

    const merged = mergeReading(
      existing,
      reading({ windows: [session({ utilization: 44 })], source: 'stream', at: NOW }),
      NOW,
    );

    // Every write wakes the icon renderer and the alert dispatcher. A reading
    // that learned nothing should not.
    expect(merged).toBeNull();
  });

  it('ignores an optimistic reading carrying no windows at all', () => {
    expect(mergeReading(null, reading({ windows: [], source: 'stream', at: NOW }), NOW)).toBeNull();
  });
});

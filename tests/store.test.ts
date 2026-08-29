/**
 * The store: whose numbers these are, and not losing them.
 *
 * Two properties that only show up under conditions the happy path never
 * reaches:
 *
 * 1. **History belongs to an account.** Switching organisation used to show the
 *    previous one's week under the new one's name, and fold new readings into
 *    the same rollups, permanently mixing two records that cannot be unmixed.
 * 2. **Read-modify-write is serialised.** `chrome.storage.local` has no
 *    transaction. A poll and a sent message land in the same second routinely,
 *    and without a queue the second write discards the first — a lost message
 *    count, in an append-only record that cannot be rebuilt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDateKey } from '~/core/normalise';
import type { DailyRollup, LimitWindow } from '~/core/types';
import {
  KEYS,
  clearSnapshot,
  readAccountEmail,
  readAllHistory,
  readHistory,
  readLeaderboardLedger,
  readSnapshot,
  readState,
  recordConfirmedLeaderboardMessage,
  recordMessage,
  recordReading,
  writeAccountEmail,
  writeAccountId,
  writeSnapshot,
} from '~/background/store';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const TODAY = localDateKey(NOW);

let fake: FakeChrome;

beforeEach(() => {
  fake = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

function window(patch: Partial<LimitWindow> & { key: string }): LimitWindow {
  return {
    label: patch.key,
    shortLabel: patch.key,
    utilization: 50,
    status: 'ok',
    resetsAt: NOW + 86_400_000,
    active: true,
    role: 'weekly',
    ...patch,
  };
}

function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

function storedHistory(): DailyRollup[] {
  return (fake.store.get(KEYS.history) ?? []) as DailyRollup[];
}

/* ---- Concurrency --------------------------------------------------------- */

describe('serialised writes', () => {
  it('does not lose a message count when several land at once', async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordMessage(NOW, 'org-1')));

    expect(storedHistory()[0]?.messageCount).toBe(10);
  });

  it('does not lose a reading when a poll and a message overlap', async () => {
    await Promise.all([
      recordReading({ '7d': 40 }, NOW, 'org-1'),
      recordMessage(NOW, 'org-1'),
      recordReading({ '7d': 55 }, NOW, 'org-1'),
      recordMessage(NOW, 'org-1'),
    ]);

    const today = storedHistory()[0];
    expect(today?.messageCount).toBe(2);
    // Peak, not latest: both readings were folded in, and the larger survives.
    expect(today?.windows).toEqual({ '7d': 55 });
  });

  it('keeps writing after one write fails', async () => {
    const real = chrome.storage.local.set;
    let failed = false;
    chrome.storage.local.set = ((items: Record<string, unknown>) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('disk gone'));
      }
      return real(items);
    }) as typeof chrome.storage.local.set;

    await expect(recordMessage(NOW, 'org-1')).rejects.toThrow('disk gone');
    // A rejection must not strand every later write behind it for the life of
    // the worker.
    await recordMessage(NOW, 'org-1');

    expect(storedHistory()[0]?.messageCount).toBe(1);
  });
});

/* ---- Accounts ------------------------------------------------------------ */

describe('history by account', () => {
  it('keeps two accounts used on the same day as two rows', async () => {
    await recordMessage(NOW, 'org-1');
    await recordMessage(NOW, 'org-2');

    expect(storedHistory()).toHaveLength(2);
    expect((await readHistory('org-1'))[0]?.messageCount).toBe(1);
    expect((await readHistory('org-2'))[0]?.messageCount).toBe(1);
  });

  it('does not show one account the other account’s week', async () => {
    await recordReading({ '7d': 90 }, NOW, 'org-2');

    expect(await readHistory('org-1')).toEqual([]);
    expect(await readAllHistory()).toHaveLength(1);
  });

  it('shows rollups written before accounts existed to whoever is signed in', async () => {
    // The upgrade path: a record with no tag was written by this user, and
    // hiding it would look like Wick lost their history.
    fake.store.set(KEYS.history, [
      { date: '2026-08-20', windows: { '7d': 30 }, messageCount: 4, hourlyMessages: new Array(24).fill(0) },
    ]);

    const history = await readHistory('org-1');

    expect(history).toHaveLength(1);
    expect(history[0]?.messageCount).toBe(4);
  });

  it('adopts an untagged day rather than splitting it in two', async () => {
    fake.store.set(KEYS.history, [
      { date: TODAY, windows: {}, messageCount: 3, hourlyMessages: new Array(24).fill(0) },
    ]);

    await recordMessage(NOW, 'org-1');

    expect(storedHistory()).toHaveLength(1);
    expect(storedHistory()[0]).toMatchObject({ messageCount: 4, accountId: 'org-1' });
  });
});

describe('readState', () => {
  it('hides a snapshot belonging to a different account', async () => {
    await writeAccountId('org-2');
    await writeSnapshot(
      {
        providerId: 'claude',
        accountId: 'org-1',
        windows: [window({ key: '7d', utilization: 99 })],
        source: 'usage',
        at: NOW,
      },
      NOW,
    );

    const state = await readState();

    // The reading is real, but it is not about the person looking at the panel.
    expect(state.snapshot).toBeNull();
  });

  it('shows a snapshot written before accounts were tracked', async () => {
    await writeAccountId('org-1');
    fake.store.set(KEYS.snapshot, {
      providerId: 'claude',
      windows: [window({ key: '7d' })],
      fetchedAt: NOW,
      source: 'usage',
    });

    expect((await readState()).snapshot?.windows).toHaveLength(1);
    expect((await readSnapshot())?.accountId).toBeNull();
  });
});

describe('clearSnapshot', () => {
  it('forgets the reading and keeps the record', async () => {
    await recordMessage(NOW, 'org-1');
    await writeSnapshot(
      {
        providerId: 'claude',
        accountId: 'org-1',
        windows: [window({ key: '7d' })],
        source: 'usage',
        at: NOW,
      },
      NOW,
    );

    await clearSnapshot();

    expect(await readSnapshot()).toBeNull();
    // Signing out is not an instruction to destroy the user's own history.
    expect(await readHistory('org-1')).toHaveLength(1);
  });
});



describe('nullable account observations', () => {
  it('persists the full A to null to B transition', async () => {
    await writeAccountEmail('  A@Example.com ');
    expect(await readAccountEmail()).toBe('a@example.com');

    await writeAccountEmail(null);
    expect(await readAccountEmail()).toBeNull();
    expect(fake.store.has(KEYS.accountEmail)).toBe(true);
    expect(fake.store.get(KEYS.accountEmail)).toBeNull();

    await writeAccountEmail('B@Example.com');
    expect(await readAccountEmail()).toBe('b@example.com');
  });
});

describe('leaderboard publication ledger', () => {
  it('aggregates trusted confirmations for one email across organisation switches', async () => {
    await writeAccountId('org-1');
    await recordConfirmedLeaderboardMessage(' Ash@Example.com ', NOW);
    await writeAccountId('org-2');
    await recordConfirmedLeaderboardMessage('ash@example.com', NOW);

    expect(await readLeaderboardLedger('ASH@EXAMPLE.COM')).toEqual([
      { date: TODAY, email: 'ash@example.com', messages: 2 },
    ]);
    // Organisation-scoped projection history is a separate record and is not
    // manufactured merely because a publishable confirmation exists.
    expect(await readAllHistory()).toEqual([]);
  });

  it('isolates two verified emails used on the same date', async () => {
    await recordConfirmedLeaderboardMessage('a@example.com', NOW);
    await recordConfirmedLeaderboardMessage('b@example.com', NOW);
    await recordConfirmedLeaderboardMessage('a@example.com', NOW);

    expect(await readLeaderboardLedger('a@example.com')).toEqual([
      { date: TODAY, email: 'a@example.com', messages: 2 },
    ]);
    expect(await readLeaderboardLedger('b@example.com')).toEqual([
      { date: TODAY, email: 'b@example.com', messages: 1 },
    ]);
  });

  it('retains an inclusive 90-calendar-day window per email without legacy backfill', async () => {
    const tooOld = localNoon(2025, 12, 30);
    const oldestRetained = localNoon(2025, 12, 31);
    const newest = localNoon(2026, 3, 30);

    await recordConfirmedLeaderboardMessage('ash@example.com', tooOld);
    await recordConfirmedLeaderboardMessage('other@example.com', tooOld);
    await recordConfirmedLeaderboardMessage('ash@example.com', oldestRetained);
    fake.store.set(KEYS.history, [
      { date: TODAY, windows: {}, messageCount: 99, hourlyMessages: new Array(24).fill(0) },
    ]);
    await recordConfirmedLeaderboardMessage('ash@example.com', newest);
    // A delayed old signal cannot widen a partition whose latest day is newer.
    await recordConfirmedLeaderboardMessage('ash@example.com', tooOld);

    expect(await readLeaderboardLedger('ash@example.com')).toEqual([
      { date: '2025-12-31', email: 'ash@example.com', messages: 1 },
      { date: '2026-03-30', email: 'ash@example.com', messages: 1 },
    ]);
    // Pruning Ash never uses Ash's date to evict another email's rows.
    expect(await readLeaderboardLedger('other@example.com')).toEqual([
      { date: '2025-12-30', email: 'other@example.com', messages: 1 },
    ]);
    expect(await readAllHistory()).toHaveLength(1);
  });

  it('uses calendar dates across the spring DST boundary rather than elapsed hours', async () => {
    await recordConfirmedLeaderboardMessage('ash@example.com', localNoon(2026, 3, 8));
    await recordConfirmedLeaderboardMessage('ash@example.com', localNoon(2026, 3, 9));
    await recordConfirmedLeaderboardMessage('ash@example.com', localNoon(2026, 6, 6));

    expect(await readLeaderboardLedger('ash@example.com')).toEqual([
      { date: '2026-03-09', email: 'ash@example.com', messages: 1 },
      { date: '2026-06-06', email: 'ash@example.com', messages: 1 },
    ]);
  });
});

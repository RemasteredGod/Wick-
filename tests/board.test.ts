/**
 * The leaderboard client.
 *
 * The behaviour worth pinning down is mostly about restraint: what does *not*
 * leave the machine, and when nothing leaves at all. A tracker that quietly
 * published more than it said it would is the failure this file exists to
 * catch, so most of these assert on the absence of a request or on the exact
 * shape of the one body that is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_ORIGIN,
  BOARD_ORIGIN_PATTERN,
  drain,
  handleBoardMessage,
  MAX_DRAIN_DAYS,
  pendingDays,
} from '~/background/board';
import { KEYS } from '~/background/store';
import { DEFAULT_SETTINGS, type DailyRollup, type Settings } from '~/core/types';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const NOW = new Date(2026, 7, 25, 14, 0).getTime();
const DAY = 86_400_000;

let fake: FakeChrome;

beforeEach(() => {
  fake = installChromeMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallChromeMock();
});

/* ---- Fixtures ------------------------------------------------------------ */

function settings(over: Partial<Settings> = {}): void {
  fake.store.set(KEYS.settings, { ...DEFAULT_SETTINGS, ...over });
}

/** Enrolled, granted, and with the board reachable. The normal case. */
function joined(over: Partial<Settings> = {}): void {
  settings({ boardToken: 'tok', boardName: 'amber-ledger-0042', ...over });
  fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
}

function rollup(date: string, messages: number, over: Partial<DailyRollup> = {}): DailyRollup {
  return {
    date,
    accountId: 'org-1',
    windows: { '7d': 40 },
    messageCount: messages,
    hourlyMessages: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? messages : 0)),
    ...over,
  };
}

function history(...days: DailyRollup[]): void {
  fake.store.set(KEYS.history, days);
  fake.store.set(KEYS.account, 'org-1');
}

type FetchMock = ReturnType<typeof ok>;

function ok(body: unknown = {}) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
}

/** The parsed bodies of every POST made, in order. */
function bodies(mock: FetchMock): unknown[] {
  return mock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? 'null')));
}

/** The URL of the nth call. */
function urlOf(mock: FetchMock, index = 0): string {
  return String(mock.mock.calls[index]?.[0]);
}

/** The init of the nth call. */
function initOf(mock: FetchMock, index = 0): RequestInit {
  return mock.mock.calls[index]?.[1] ?? {};
}

/* ---- Nothing by default -------------------------------------------------- */

describe('before joining', () => {
  it('sends nothing at all', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    settings();
    history(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing even with a token, until the origin is granted', async () => {
    // The grant is revocable from Chrome's own UI at any time, so it is checked
    // on every call rather than assumed from the fact that enrolment happened.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    settings({ boardToken: 'tok' });
    history(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ---- What gets published ------------------------------------------------- */

describe('what leaves the machine', () => {
  it('sends a day and a count, and nothing else from the rollup', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);

    // The rollup it came from also holds an account id, per-window percentages
    // and a 24-slot hourly breakdown. None of them may travel.
    const sent = JSON.stringify(bodies(fetchMock));
    expect(sent).not.toContain('org-1');
    expect(sent).not.toContain('hourly');
    expect(sent).not.toContain('7d');
  });

  it('carries the token as a bearer header and no cookies', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(urlOf(fetchMock)).toBe(`${BOARD_ORIGIN}/api/submit`);
    const request = initOf(fetchMock);
    expect((request.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(request.credentials).toBe('omit');
  });

  it('never publishes today, because today is still accumulating', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-25', 12), rollup('2026-08-24', 30));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
  });

  it('publishes a measured zero rather than skipping the day', async () => {
    // A day on which nothing was sent is an observation, and dropping it would
    // put a hole in a streak the board computes from consecutive days.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-24', 0));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 0 }]);
  });

  it('publishes only the signed-in account, not another organisation', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    fake.store.set(KEYS.history, [
      rollup('2026-08-24', 30),
      rollup('2026-08-23', 999, { accountId: 'org-other' }),
    ]);
    fake.store.set(KEYS.account, 'org-1');

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
  });
});

/* ---- The high-water mark ------------------------------------------------- */

describe('the backlog', () => {
  it('sends oldest first and advances the mark past each accepted day', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-22', 1), rollup('2026-08-24', 3), rollup('2026-08-23', 2));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([
      { day: '2026-08-22', messages: 1 },
      { day: '2026-08-23', messages: 2 },
      { day: '2026-08-24', messages: 3 },
    ]);
    expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBe('2026-08-24');
  });

  it('does not resend a day already published', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined({ boardSubmittedThrough: '2026-08-23' });
    history(rollup('2026-08-22', 1), rollup('2026-08-23', 2), rollup('2026-08-24', 3));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 3 }]);
  });

  it('stops at the first refusal rather than skipping past a gap', async () => {
    // The mark is a single date, so a day sent after a failed one would either
    // be lost or force this to remember a set instead.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return new Response('{}', { status: call === 2 ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();
    history(rollup('2026-08-22', 1), rollup('2026-08-23', 2), rollup('2026-08-24', 3));

    await drain(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBe('2026-08-22');
  });

  it('caps one drain so a long absence is not one enormous burst', async () => {
    const days = Array.from({ length: 40 }, (_, index) =>
      rollup(new Date(NOW - (index + 1) * DAY).toISOString().slice(0, 10), 1),
    );
    fake.store.set(KEYS.history, days);
    fake.store.set(KEYS.account, 'org-1');
    settings({ boardToken: 'tok' });

    const pending = await pendingDays(null, NOW);
    expect(pending.length).toBeLessThanOrEqual(MAX_DRAIN_DAYS);
  });

  it('survives a rollup with an unusable count instead of publishing NaN', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    fake.store.set(KEYS.history, [
      { ...rollup('2026-08-23', 0), messageCount: Number.NaN },
      rollup('2026-08-24', 3),
    ]);
    fake.store.set(KEYS.account, 'org-1');

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 3 }]);
  });
});

/* ---- Joining and leaving ------------------------------------------------- */

describe('joining', () => {
  async function ask(message: unknown): Promise<unknown> {
    return fake.sendToWorker(message);
  }

  beforeEach(() => {
    chrome.runtime.onMessage.addListener(handleBoardMessage);
  });

  it('stores the token and name the board hands back', async () => {
    vi.stubGlobal('fetch', ok({ token: 'minted', name: 'amber-ledger-0042' }));
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({ ok: true, outcome: 'ok' });

    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBe('minted');
    expect(stored.boardName).toBe('amber-ledger-0042');
  });

  it('sends an empty body, because there is nothing to identify the user with', async () => {
    const fetchMock = ok({ token: 'minted', name: 'n' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);

    await ask({ type: 'wick:board-enroll' });

    expect(bodies(fetchMock)).toEqual([{}]);
  });

  it('writes nothing when the board is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBeNull();
  });

  it('does not mint a second token for an installation already enrolled', async () => {
    // The first token owns every day published under it. Replacing it would
    // orphan all of them.
    const fetchMock = ok({ token: 'second', name: 'other' });
    vi.stubGlobal('fetch', fetchMock);
    joined();

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({ ok: true, outcome: 'ok' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });
});

describe('leaving', () => {
  beforeEach(() => {
    chrome.runtime.onMessage.addListener(handleBoardMessage);
  });

  it('asks the board to delete the rows, then forgets the token', async () => {
    const fetchMock = ok({ left: true });
    vi.stubGlobal('fetch', fetchMock);
    joined({ boardSubmittedThrough: '2026-08-24' });

    expect(await fake.sendToWorker({ type: 'wick:board-leave' })).toEqual({
      ok: true,
      outcome: 'ok',
    });

    expect(urlOf(fetchMock)).toBe(`${BOARD_ORIGIN}/api/leave`);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBeNull();
    expect(stored.boardName).toBeNull();
    expect(stored.boardSubmittedThrough).toBeNull();
  });

  it('keeps the token when the delete failed, so leaving can be retried', async () => {
    // Clearing it locally would strand rows on a public page under a name the
    // user has been told they gave up.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    joined();

    expect(await fake.sendToWorker({ type: 'wick:board-leave' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });
});

/* ---- Robustness ---------------------------------------------------------- */

describe('failures', () => {
  it('never throws when the network does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    joined();
    history(rollup('2026-08-24', 30));

    await expect(drain(NOW)).resolves.toBeUndefined();
    expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBeNull();
  });

  it('leaves other messages for the collector to answer', () => {
    const claimed = handleBoardMessage(
      { type: 'wick:refresh' },
      {} as chrome.runtime.MessageSender,
      () => undefined,
    );
    expect(claimed).toBe(false);
  });
});

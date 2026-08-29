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
  adopt,
  BOARD_ORIGIN,
  BOARD_ORIGIN_PATTERN,
  drain,
  handleBoardMessage,
  initBoard,
} from '~/background/board';
import { POLL_ALARM } from '~/background/alarms';
import { KEYS } from '~/background/store';
import { DEFAULT_SETTINGS, type DailyRollup, type Settings } from '~/core/types';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const NOW = new Date(2026, 7, 25, 14, 0).getTime();
const ASH = 'ash@example.com';
const OTHER = 'someone-else@example.com';

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

/** Which Claude account the content script last reported. */
function signedInAs(email: string | null): void {
  if (email === null) fake.store.delete(KEYS.accountEmail);
  else fake.store.set(KEYS.accountEmail, email);
}

/** Enrolled, granted, and with the board reachable. The normal case. */
function joined(over: Partial<Settings> = {}): void {
  settings({ boardToken: 'tok', boardName: 'amber-ledger-0042', boardEmail: ASH, ...over });
  fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
  signedInAs(ASH);
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

function ledger(...days: DailyRollup[]): void {
  ledgerFor(ASH, ...days);
}

function ledgerFor(email: string, ...days: DailyRollup[]): void {
  const existing = (fake.store.get(KEYS.boardLedger) as unknown[] | undefined) ?? [];
  fake.store.set(KEYS.boardLedger, [
    ...existing,
    ...days.map((day) => ({ date: day.date, email, messages: day.messageCount })),
  ]);
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


/** Pause the next settings write that clears an enrolment before it reaches storage. */
function pauseNextEnrollmentClear(): { started: Promise<void>; release(): void } {
  let markStarted: (() => void) | undefined;
  let allowWrite: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    allowWrite = resolve;
  });
  const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
  let paused = false;

  vi.spyOn(chrome.storage.local, 'set').mockImplementation(async (items) => {
    const next = (items as Record<string, unknown>)[KEYS.settings] as Settings | undefined;
    if (!paused && next?.boardToken === null && next.boardName === null) {
      paused = true;
      markStarted?.();
      await released;
    }
    await originalSet(items);
  });

  return { started, release: () => allowWrite?.() };
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
    ledger(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing even with a token, until the origin is granted', async () => {
    // The grant is revocable from Chrome's own UI at any time, so it is checked
    // on every call rather than assumed from the fact that enrolment happened.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    settings({ boardToken: 'tok' });
    ledger(rollup('2026-08-24', 30));

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
    ledger(rollup('2026-08-24', 30));

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
    ledger(rollup('2026-08-24', 30));

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
    ledger(rollup('2026-08-25', 12), rollup('2026-08-24', 30));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
  });

  it('publishes a measured zero rather than skipping the day', async () => {
    // A day on which nothing was sent is an observation, and dropping it would
    // put a hole in a streak the board computes from consecutive days.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 0));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 0 }]);
  });

  it('publishes only the freshly observed email ledger, not another account ledger', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    ledgerFor(OTHER, rollup('2026-08-23', 999));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
  });

  it('keeps ambiguous legacy organisation rollups local instead of backfilling them', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    fake.store.set(KEYS.history, [rollup('2026-08-24', 999)]);

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.store.get(KEYS.history)).toEqual([rollup('2026-08-24', 999)]);
  });
});

/* ---- The high-water mark ------------------------------------------------- */

describe('the backlog', () => {
  it('sends oldest first and advances the mark past each accepted day', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-22', 1), rollup('2026-08-24', 3), rollup('2026-08-23', 2));

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
    ledger(rollup('2026-08-22', 1), rollup('2026-08-23', 2), rollup('2026-08-24', 3));

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
    ledger(rollup('2026-08-22', 1), rollup('2026-08-23', 2), rollup('2026-08-24', 3));

    await drain(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBe('2026-08-22');
  });

  it('skips sparse rows outside the 90-day calendar window instead of wedging newer days', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(
      rollup('2025-01-01', 999),
      rollup('2026-05-27', 888),
      rollup('2026-05-28', 1),
      rollup('2026-08-24', 2),
    );

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([
      { day: '2026-05-28', messages: 1 },
      { day: '2026-08-24', messages: 2 },
    ]);
  });

  it('drains a 40-day backlog in oldest-first batches of 14, 14, and 12', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    const days = Array.from({ length: 40 }, (_, index) => {
      const date = new Date(2026, 7, 24 - index, 12, 0);
      const key = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('-');
      return rollup(key, index + 1);
    });
    ledger(...days);

    await drain(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    expect((bodies(fetchMock)[0] as { day: string }).day).toBe('2026-07-16');
    expect((bodies(fetchMock)[13] as { day: string }).day).toBe('2026-07-29');

    await drain(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(28);
    expect((bodies(fetchMock)[14] as { day: string }).day).toBe('2026-07-30');
    expect((bodies(fetchMock)[27] as { day: string }).day).toBe('2026-08-12');

    await drain(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect((bodies(fetchMock)[28] as { day: string }).day).toBe('2026-08-13');
    expect((bodies(fetchMock)[39] as { day: string }).day).toBe('2026-08-24');
    expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBe('2026-08-24');
  });

  it('survives a ledger row with an unusable count instead of publishing NaN', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    fake.store.set(KEYS.boardLedger, [
      { date: '2026-08-23', email: ASH, messages: Number.NaN },
      { date: '2026-08-24', email: ASH, messages: 3 },
    ]);

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

  it('stores the token, name and account the board bound them to', async () => {
    vi.stubGlobal('fetch', ok({ token: 'minted', name: 'amber-ledger-0042' }));
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(ASH);

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({ ok: true, outcome: 'ok' });

    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBe('minted');
    expect(stored.boardName).toBe('amber-ledger-0042');
    expect(stored.boardEmail).toBe(ASH);
  });

  it('drains already completed rows immediately after successful enrolment', async () => {
    const fetchMock = ok({ token: 'minted', name: 'amber-ledger-0042' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(ASH);
    ledger(rollup('2026-08-24', 30));

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({ ok: true, outcome: 'ok' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 0)).toBe(`${BOARD_ORIGIN}/api/enroll`);
    expect(urlOf(fetchMock, 1)).toBe(`${BOARD_ORIGIN}/api/submit`);
    expect(bodies(fetchMock)).toEqual([
      { email: ASH },
      { day: '2026-08-24', messages: 30 },
    ]);
  });

  it('sends the account and nothing else', async () => {
    // The email is the profile's primary key, so it has to travel — but only
    // this once, and with nothing else alongside it.
    const fetchMock = ok({ token: 'minted', name: 'n' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(ASH);

    await ask({ type: 'wick:board-enroll' });

    expect(bodies(fetchMock)).toEqual([{ email: ASH }]);
  });

  it('says the account is unknown rather than blaming the board', async () => {
    // Signed out, no claude.ai tab, or a sidebar this build renders
    // differently. Nothing is down, and reporting it as "could not reach the
    // leaderboard" sends people to check a server that is answering perfectly.
    const fetchMock = ok({ token: 'minted', name: 'n' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(null);

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({
      ok: true,
      outcome: 'no-account',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks an open claude.ai tab when it has not been told the account yet', async () => {
    // Join is pressed in the popup, which cannot read the page, and the content
    // script reports on a five-second poll. Someone who installs Wick and opens
    // the popup promptly would otherwise be refused for no reason.
    const fetchMock = ok({ token: 'minted', name: 'amber-ledger-0042' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(null);

    fake.tabs.push({ url: 'https://claude.ai/chats' });
    fake.tabReplies.set('wick:read-account', { ok: true, email: ASH });

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({ ok: true, outcome: 'ok' });

    expect(bodies(fetchMock)).toEqual([{ email: ASH }]);
    // And it remembers, so the next caller does not have to ask again.
    expect(fake.store.get(KEYS.accountEmail)).toBe(ASH);
  });

  it('revalidates a cached account against an open claude.ai tab', async () => {
    const fetchMock = ok({ token: 'minted', name: 'n' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(ASH);
    fake.tabs.push({ url: 'https://claude.ai/chats' });
    fake.tabReplies.set('wick:read-account', { ok: true, email: ASH });

    await ask({ type: 'wick:board-enroll' });

    expect(fake.tabMessages).toHaveLength(1);
    expect(bodies(fetchMock)).toEqual([{ email: ASH }]);
  });

  it('blocks enrolment when one open provider tab rejects and another confirms', async () => {
    const fetchMock = ok({ token: 'minted', name: 'amber-ledger-0042' });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(null);

    fake.tabs.push({ url: 'https://claude.ai/stale' });
    fake.tabs.push({ url: 'https://claude.ai/chats' });
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = ((tabId: number) =>
      tabId === 1
        ? Promise.reject(new Error('Receiving end does not exist.'))
        : Promise.resolve({ ok: true, email: ASH })) as typeof chrome.tabs.sendMessage;

    try {
      expect(await ask({ type: 'wick:board-enroll' })).toEqual({
        ok: true,
        outcome: 'no-account',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      chrome.tabs.sendMessage = original;
    }
  });

  it('reports no-account when the tab cannot say either', async () => {
    // A claude.ai tab whose content script has not loaded, or a signed-out page.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    signedInAs(null);
    fake.tabs.push({ url: 'https://claude.ai/chats' });

    expect(await ask({ type: 'wick:board-enroll' })).toEqual({
      ok: true,
      outcome: 'no-account',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes nothing when the board is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    settings();
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    // Past the account check, so this exercises the network failure and not the
    // one before it.
    signedInAs(ASH);

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

/* ---- Switching accounts -------------------------------------------------- */

describe('when the signed-in account changes', () => {
  it('records the account without joining anything', async () => {
    // Reading the address is free. Sending it is not, and an installation that
    // never pressed Join never does.
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    settings();

    await adopt(ASH);

    expect(fake.store.get(KEYS.accountEmail)).toBe(ASH);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-enrols for the new account, keeping nothing from the old one', async () => {
    const fetchMock = ok({ token: 'second-token', name: 'quiet-harbour-7781' });
    vi.stubGlobal('fetch', fetchMock);
    joined({ boardSubmittedThrough: '2026-08-24' });

    await adopt(OTHER);

    expect(bodies(fetchMock)).toEqual([{ email: OTHER }]);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardEmail).toBe(OTHER);
    expect(stored.boardToken).toBe('second-token');
    expect(stored.boardName).toBe('quiet-harbour-7781');
    // The mark belongs to a profile, not to the machine.
    expect(stored.boardSubmittedThrough).toBeNull();
  });

  it('does not leave the old account token in place when re-enrolling fails', async () => {
    // Publishing this account's days under the previous account's token would
    // attribute somebody's work to somebody else's public page.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    joined();

    await adopt(OTHER);

    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBeNull();
  });

  it('does nothing when the account has not actually changed', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();

    await adopt(ASH);
    // Same address, differently cased and padded, is the same account.
    await adopt(`  ${ASH.toUpperCase()}  `);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });

  it('publishes nothing while the token belongs to a different account', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    // Signed into another account, and not yet re-enrolled.
    signedInAs(OTHER);

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
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
    ledger(rollup('2026-08-24', 30));

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


/* ---- Synchronization observability -------------------------------------- */

describe('synchronization state', () => {
  it('waits for today to close without ever submitting it', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-25', 12));

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
      kind: 'waiting-for-day-close',
    });
  });

  it('persists syncing while a completed day is in flight, then accepted-through', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    const running = drain(NOW);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
        kind: 'syncing',
      });
    });

    resolveResponse?.(new Response('{}', { status: 200 }));
    await running;

    expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
      kind: 'accepted-through',
      day: '2026-08-24',
    });
  });

  it('marks retry without advancing high-water, then accepts on the next drain', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return new Response('{}', { status: call === 1 ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    await drain(NOW);

    let stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardSubmittedThrough).toBeNull();
    expect(stored.boardSyncState).toEqual({ kind: 'retry-pending' });

    await drain(NOW);

    stored = fake.store.get(KEYS.settings) as Settings;
    expect(bodies(fetchMock)).toEqual([
      { day: '2026-08-24', messages: 30 },
      { day: '2026-08-24', messages: 30 },
    ]);
    expect(stored.boardSubmittedThrough).toBe('2026-08-24');
    expect(stored.boardSyncState).toEqual({
      kind: 'accepted-through',
      day: '2026-08-24',
    });
  });

  it('clears a dead enrolment on submit 401 without automatically rejoining', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    joined({ boardSubmittedThrough: '2026-08-23' });
    ledger(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock)).toBe(`${BOARD_ORIGIN}/api/submit`);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBeNull();
    expect(stored.boardName).toBeNull();
    expect(stored.boardEmail).toBeNull();
    expect(stored.boardSubmittedThrough).toBeNull();
  });

  it('fails closed when either side of the account binding is unknown', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    signedInAs(null);
    await drain(NOW);

    signedInAs(ASH);
    settings({ boardToken: 'tok', boardName: 'amber-ledger-0042', boardEmail: null });
    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
      kind: 'retry-pending',
    });
  });
});

/* ---- Worker lifecycle ---------------------------------------------------- */

describe('worker lifecycle', () => {
  it('drains completed rows as soon as the worker starts', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    initBoard();

    await vi.waitFor(() => {
      expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
    });
  });
});



/* ---- Reviewer regression coverage --------------------------------------- */

describe('live account revalidation before publication', () => {
  it('allows the cached binding when no provider tab is open', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    await drain(NOW);

    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
    expect(fake.tabMessages).toHaveLength(0);
  });

  it('blocks a cached account when an open provider tab reports null', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    fake.tabs.push({ url: 'https://claude.ai/chats' });
    fake.tabReplies.set('wick:read-account', { ok: true, email: null });

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.tabMessages).toHaveLength(1);
    expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
      kind: 'retry-pending',
    });
  });

  it('blocks a cached account when an open provider tab reports another account', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    fake.tabs.push({ url: 'https://claude.ai/chats' });
    fake.tabReplies.set('wick:read-account', { ok: true, email: OTHER });

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.store.get(KEYS.accountEmail)).toBe(OTHER);
  });

  it('blocks publication when one open provider tab confirms and another reports null', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    fake.tabs.push({ url: 'https://claude.ai/chats/one' });
    fake.tabs.push({ url: 'https://claude.ai/chats/two' });
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = ((tabId: number) =>
      Promise.resolve(
        tabId === 1 ? { ok: true, email: ASH } : { ok: true, email: null },
      )) as typeof chrome.tabs.sendMessage;

    try {
      await drain(NOW);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      chrome.tabs.sendMessage = original;
    }
  });

  it('blocks publication when open provider tabs report conflicting accounts', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    fake.tabs.push({ url: 'https://claude.ai/chats/one' });
    fake.tabs.push({ url: 'https://claude.ai/chats/two' });
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = ((tabId: number) =>
      Promise.resolve({ ok: true, email: tabId === 1 ? ASH : OTHER })) as typeof chrome.tabs.sendMessage;

    try {
      await drain(NOW);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      chrome.tabs.sendMessage = original;
    }
  });

  it('does not claim completed days are waiting when only today exists', async () => {
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);
    joined();
    signedInAs(null);
    ledger(rollup('2026-08-25', 12));

    await drain(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.store.get(KEYS.settings) as Settings).boardSyncState).toEqual({
      kind: 'waiting-for-day-close',
    });
  });
});

describe('typed board refusals', () => {
  it.each([400, 401])('does not persist enrolment after an enroll %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
    settings();
    signedInAs(ASH);
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    chrome.runtime.onMessage.addListener(handleBoardMessage);

    expect(await fake.sendToWorker({ type: 'wick:board-enroll' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBeNull();
  });

  it('does not report a durable join when the immediate submit is unauthorized', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/api/enroll')
        ? new Response(JSON.stringify({ token: 'minted', name: 'amber-ledger-0042' }), {
            status: 200,
          })
        : new Response('{}', { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    settings();
    signedInAs(ASH);
    ledger(rollup('2026-08-24', 30));
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    chrome.runtime.onMessage.addListener(handleBoardMessage);

    expect(await fake.sendToWorker({ type: 'wick:board-enroll' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBeNull();
    expect(stored.boardEmail).toBeNull();
  });

  it('retains the binding and high-water mark after a rejected submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    joined({ boardSubmittedThrough: '2026-08-23' });
    ledger(rollup('2026-08-24', 30));

    await drain(NOW);

    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBe('tok');
    expect(stored.boardSubmittedThrough).toBe('2026-08-23');
    expect(stored.boardSyncState).toEqual({ kind: 'retry-pending' });
  });

  it.each([400, 401])('retains the credential after a leave %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
    joined();
    chrome.runtime.onMessage.addListener(handleBoardMessage);

    expect(await fake.sendToWorker({ type: 'wick:board-leave' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });
});

describe('the board operation coordinator', () => {
  it('coalesces startup and its poll alarm while one submit is held', async () => {
    let resolveSubmit: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    initBoard();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fake.fireAlarm(POLL_ALARM);
    resolveSubmit?.(new Response('{}', { status: 200 }));
    await vi.waitFor(() => {
      expect((fake.store.get(KEYS.settings) as Settings).boardSubmittedThrough).toBe('2026-08-24');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies(fetchMock)).toEqual([{ day: '2026-08-24', messages: 30 }]);
  });

  it('does not let a stale submit 401 consume the credential Leave needs', async () => {
    let resolveSubmit: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/submit')) {
        return new Promise<Response>((resolve) => {
          resolveSubmit = resolve;
        });
      }
      return Promise.resolve(new Response('{}', { status: 400 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    chrome.runtime.onMessage.addListener(handleBoardMessage);

    const publishing = drain(NOW);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const leaving = fake.sendToWorker({ type: 'wick:board-leave' });
    resolveSubmit?.(new Response('{}', { status: 401 }));

    await publishing;
    expect(await leaving).toEqual({ ok: true, outcome: 'unavailable' });
    expect(urlOf(fetchMock, 1)).toBe(`${BOARD_ORIGIN}/api/leave`);
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });

  it('does not let a stale submit 401 clear a newly adopted binding', async () => {
    let resolveSubmit: ((response: Response) => void) | undefined;
    let submitCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/submit')) {
        submitCalls += 1;
        if (submitCalls === 1) {
          return new Promise<Response>((resolve) => {
            resolveSubmit = resolve;
          });
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'new-token', name: 'quiet-harbour-7781' }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));

    const publishing = drain(NOW);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const adopting = adopt(OTHER);
    resolveSubmit?.(new Response('{}', { status: 401 }));

    await Promise.all([publishing, adopting]);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardEmail).toBe(OTHER);
    expect(stored.boardToken).toBe('new-token');
    expect(stored.boardName).toBe('quiet-harbour-7781');
  });

  it('restores the old credential when Leave arrives during the 401 clear write', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(new Response('{}', { status: url.endsWith('/api/submit') ? 401 : 400 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    chrome.runtime.onMessage.addListener(handleBoardMessage);
    const pausedClear = pauseNextEnrollmentClear();

    const publishing = drain(NOW);
    await pausedClear.started;
    const leaving = fake.sendToWorker({ type: 'wick:board-leave' });
    pausedClear.release();

    await publishing;
    expect(await leaving).toEqual({ ok: true, outcome: 'unavailable' });
    expect(urlOf(fetchMock, 1)).toBe(`${BOARD_ORIGIN}/api/leave`);
    expect((initOf(fetchMock, 1).headers as Record<string, string>)['authorization']).toBe(
      'Bearer tok',
    );
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');
  });

  it('restores the old binding before adoption runs during the 401 clear write', async () => {
    let submitCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/submit')) {
        submitCalls += 1;
        return Promise.resolve(new Response('{}', { status: submitCalls === 1 ? 401 : 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'new-token', name: 'quiet-harbour-7781' }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();
    ledger(rollup('2026-08-24', 30));
    const pausedClear = pauseNextEnrollmentClear();

    const publishing = drain(NOW);
    await pausedClear.started;
    const adopting = adopt(OTHER);
    pausedClear.release();

    await Promise.all([publishing, adopting]);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardEmail).toBe(OTHER);
    expect(stored.boardToken).toBe('new-token');
    expect(stored.boardName).toBe('quiet-harbour-7781');
    // The completed row belongs to the old email's ledger and must not cross
    // the account switch merely because both accounts used this browser.
    expect(stored.boardSubmittedThrough).toBeNull();
  });
});


describe('ordered identity operations', () => {
  beforeEach(() => {
    chrome.runtime.onMessage.addListener(handleBoardMessage);
  });

  it('uses a token minted by an in-flight enrolment for a queued Leave', async () => {
    let resolveEnroll: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/enroll')) {
        return new Promise<Response>((resolve) => {
          resolveEnroll = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ left: true }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    settings();
    signedInAs(ASH);
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);

    const enrolling = fake.sendToWorker({ type: 'wick:board-enroll' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const leaving = fake.sendToWorker({ type: 'wick:board-leave' });
    resolveEnroll?.(
      new Response(JSON.stringify({ token: 'minted', name: 'amber-ledger-0042' }), {
        status: 200,
      }),
    );

    expect(await enrolling).toEqual({ ok: true, outcome: 'ok' });
    expect(await leaving).toEqual({ ok: true, outcome: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe(`${BOARD_ORIGIN}/api/leave`);
    expect((initOf(fetchMock, 1).headers as Record<string, string>)['authorization']).toBe(
      'Bearer minted',
    );
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBeNull();
  });

  it('finishes an accepted Leave before a queued enrolment creates a new binding', async () => {
    let resolveLeave: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/leave')) {
        return new Promise<Response>((resolve) => {
          resolveLeave = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'new-token', name: 'quiet-harbour-7781' }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    joined();

    const leaving = fake.sendToWorker({ type: 'wick:board-leave' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const enrolling = fake.sendToWorker({ type: 'wick:board-enroll' });
    resolveLeave?.(new Response(JSON.stringify({ left: true }), { status: 200 }));

    expect(await leaving).toEqual({ ok: true, outcome: 'ok' });
    expect(await enrolling).toEqual({ ok: true, outcome: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 0)).toBe(`${BOARD_ORIGIN}/api/leave`);
    expect(urlOf(fetchMock, 1)).toBe(`${BOARD_ORIGIN}/api/enroll`);
    const stored = fake.store.get(KEYS.settings) as Settings;
    expect(stored.boardToken).toBe('new-token');
    expect(stored.boardEmail).toBe(ASH);
  });
});



describe('runtime sender trust', () => {
  beforeEach(() => {
    chrome.runtime.onMessage.addListener(handleBoardMessage);
  });

  it('rejects board actions from another extension or a provider tab', async () => {
    settings();
    signedInAs(ASH);
    fake.grantedOrigins.add(BOARD_ORIGIN_PATTERN);
    const fetchMock = ok({ token: 'minted', name: 'n' });
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await fake.sendToWorker(
        { type: 'wick:board-enroll' },
        { ...fake.popupSender(), id: 'other-extension' },
      ),
    ).toBeUndefined();
    expect(
      await fake.sendToWorker({ type: 'wick:board-enroll' }, fake.contentSender()),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects account observations with a wrong id, provider URL, or frame', async () => {
    settings();

    for (const sender of [
      { ...fake.contentSender(), id: 'other-extension' },
      fake.contentSender('https://example.com/forged'),
      fake.contentSender('https://claude.ai/chats', 1),
      fake.popupSender(),
    ]) {
      await fake.sendToWorker({ type: 'wick:account-email', email: ASH }, sender);
    }

    expect(fake.store.has(KEYS.accountEmail)).toBe(false);
  });

  it('persists A to null without discarding the token needed by Leave, then adopts B', async () => {
    const fetchMock = ok({ token: 'second-token', name: 'quiet-harbour-7781' });
    vi.stubGlobal('fetch', fetchMock);
    joined();

    await fake.sendToWorker(
      { type: 'wick:account-email', email: null },
      fake.contentSender(),
    );
    await vi.waitFor(() => expect(fake.store.get(KEYS.accountEmail)).toBeNull());
    expect(fake.store.has(KEYS.accountEmail)).toBe(true);
    expect((fake.store.get(KEYS.settings) as Settings).boardToken).toBe('tok');

    await fake.sendToWorker(
      { type: 'wick:account-email', email: OTHER },
      fake.contentSender(),
    );
    await vi.waitFor(() => {
      const stored = fake.store.get(KEYS.settings) as Settings;
      expect(fake.store.get(KEYS.accountEmail)).toBe(OTHER);
      expect(stored.boardEmail).toBe(OTHER);
      expect(stored.boardToken).toBe('second-token');
    });
  });
});

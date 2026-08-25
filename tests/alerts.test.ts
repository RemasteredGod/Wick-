/**
 * The alert dispatcher.
 *
 * The behaviour under test is mostly a negative one — how often Wick *stays
 * quiet*. Three message types, at most one per event; a tracker that spams is a
 * tracker you mute. So most of these tests assert that a second, third and
 * fourth snapshot produce nothing.
 *
 * `evaluateSnapshotChange` is driven directly rather than through storage in
 * most cases, because the listener path dispatches without awaiting and testing
 * it means testing a timer. One test covers that path end to end so the
 * subscription itself is not taken on trust.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cycleKeyFor,
  evaluateSnapshotChange,
  handleTelegramMessage,
  initAlerts,
  resetMessage,
  thresholdMessage,
  weeklySummaryMessage,
  weeklyWindow,
} from '~/background/alerts';
import { TELEGRAM_ORIGIN } from '~/background/telegram';
import { KEYS } from '~/background/store';
import { DEFAULT_SETTINGS, type DailyRollup, type LimitWindow, type Settings } from '~/core/types';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const NOW = new Date(2026, 7, 24, 14, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

let fake: FakeChrome;

beforeEach(() => {
  fake = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

/* ---- Fixtures ------------------------------------------------------------ */

function limitWindow(patch: Partial<LimitWindow> & { key: string }): LimitWindow {
  return {
    label: patch.key,
    shortLabel: patch.key,
    utilization: 0,
    status: 'ok',
    resetsAt: null,
    active: true,
    role: 'other',
    ...patch,
  };
}

const session = (utilization: number, resetsAt: number) =>
  limitWindow({
    key: '5h',
    label: 'Session · 5 hr',
    shortLabel: 'Session',
    role: 'session',
    utilization,
    resetsAt,
  });

const weekly = (utilization: number, resetsAt: number) =>
  limitWindow({
    key: '7d',
    label: 'Weekly',
    shortLabel: 'Weekly',
    role: 'weekly',
    utilization,
    resetsAt,
  });

function snapshot(windows: LimitWindow[]): unknown {
  return { providerId: 'claude', windows, fetchedAt: NOW, source: 'usage' };
}

function settings(patch: Partial<Settings> = {}): void {
  fake.store.set(KEYS.settings, { ...DEFAULT_SETTINGS, ...patch });
}

function history(counts: number[]): void {
  const days: DailyRollup[] = counts.map((messageCount, offset) => {
    const day = new Date(NOW - offset * DAY);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    return {
      date: `${day.getFullYear()}-${month}-${date}`,
      windows: { '7d': 50 },
      messageCount,
      hourlyMessages: new Array<number>(24).fill(0),
    };
  });
  fake.store.set(KEYS.history, days);
}

/** The `message` of every notification sent so far, in order. */
function messages(): string[] {
  return fake.notifications.map((options) => String((options as { message?: unknown }).message));
}

/** A resolved-promise chain plus a macrotask: enough to drain the listener. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ---- Threshold crossing -------------------------------------------------- */

describe('threshold alerts', () => {
  it('fires exactly one notification when the weekly window crosses', async () => {
    settings();

    await evaluateSnapshotChange(
      undefined,
      snapshot([session(30, NOW + 3 * HOUR), weekly(82, NOW + 4 * DAY)]),
      NOW,
    );

    expect(fake.notifications).toHaveLength(1);
    expect(messages()[0]).toBe('Weekly usage 82% — 4 days to reset.');
  });

  it('stays quiet on a second snapshot in the same cycle', async () => {
    settings();
    const resetsAt = NOW + 4 * DAY;

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, resetsAt)]), NOW);
    // Higher, still the same cycle. The user has already been told.
    await evaluateSnapshotChange(
      snapshot([weekly(82, resetsAt)]),
      snapshot([weekly(91, resetsAt)]),
      NOW + HOUR,
    );

    expect(fake.notifications).toHaveLength(1);
  });

  it('fires again once the window has rolled over', async () => {
    settings();

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);
    // A new reset time is a new cycle, so the same warning is legitimate again.
    // `before` is undefined here the way it is after a worker restart, which
    // also keeps this test to the threshold path alone.
    await evaluateSnapshotChange(
      undefined,
      snapshot([weekly(84, NOW + 11 * DAY)]),
      NOW + 7 * DAY,
    );

    expect(fake.notifications).toHaveLength(2);
  });

  it('says nothing below the configured threshold', async () => {
    settings({ alertThreshold: 90 });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fake.notifications).toHaveLength(0);
  });

  it('fires on an exceeded status even when the percentage is unknown', async () => {
    settings();

    await evaluateSnapshotChange(
      undefined,
      snapshot([
        limitWindow({
          key: '7d',
          shortLabel: 'Weekly',
          utilization: null,
          status: 'exceeded',
          resetsAt: NOW + 2 * DAY,
        }),
      ]),
      NOW,
    );

    expect(messages()).toEqual(['Weekly limit reached — 2 days to reset.']);
  });
});

/* ---- Rollovers ----------------------------------------------------------- */

describe('rollover alerts', () => {
  it('reports a session window reset', async () => {
    settings();

    await evaluateSnapshotChange(
      snapshot([session(96, NOW), weekly(60, NOW + 4 * DAY)]),
      snapshot([session(0, NOW + 5 * HOUR), weekly(60, NOW + 4 * DAY)]),
      NOW,
    );

    expect(messages()).toEqual(['Session window reset. 0% used.']);
  });

  it('suppresses reset messages when alertOnReset is false', async () => {
    settings({ alertOnReset: false });

    await evaluateSnapshotChange(
      snapshot([session(96, NOW), weekly(60, NOW + 4 * DAY)]),
      snapshot([session(0, NOW + 5 * HOUR), weekly(60, NOW + 4 * DAY)]),
      NOW,
    );

    expect(fake.notifications).toHaveLength(0);
  });

  it('sends the weekly summary rather than a bare reset line', async () => {
    settings();
    history([40, 30, 26, 60, 20, 10, 10]);

    await evaluateSnapshotChange(
      snapshot([weekly(94, NOW)]),
      snapshot([weekly(0, NOW + 7 * DAY)]),
      NOW,
    );

    expect(messages()[0]).toMatch(/^Weekly reset\. Last week: 196 messages, peak \w+\.$/);
  });

  it('does not repeat a rollover already reported', async () => {
    settings();
    const before = snapshot([session(96, NOW)]);
    const after = snapshot([session(0, NOW + 5 * HOUR)]);

    await evaluateSnapshotChange(before, after, NOW);
    await evaluateSnapshotChange(before, after, NOW + 60_000);

    expect(fake.notifications).toHaveLength(1);
  });
});

/* ---- Telegram ------------------------------------------------------------ */

const OK = () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });

describe('telegram dispatch', () => {
  it('does not call Telegram when no token is stored', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: null, chatId: null });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fake.notifications).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call Telegram when a token has no chat', async () => {
    // Half-connected is the state a failed chat lookup would leave behind.
    // Sending would throw away the alert against a chat_id of null.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: 'bot-token', chatId: null });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fake.notifications).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts straight to the bot when a token and chat are stored', async () => {
    const fetchMock = vi.fn(OK);
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: '123:ABC', chatId: 4242, chatLabel: '@someone' });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${TELEGRAM_ORIGIN}/bot123:ABC/sendMessage`);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['chat_id']).toBe(4242);
    expect(String(body['text'])).toContain('Weekly usage 82%');
    // A stray underscore in an alert must never come back as a 400. The
    // extension composes the text and nothing here interprets it.
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('sends no Authorization header — the token is in the path', async () => {
    const fetchMock = vi.fn(OK);
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: '123:ABC', chatId: 4242 });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    // And never on a cookie: Telegram must not act on a request the browser
    // made on its own.
    expect(init.credentials).toBe('omit');
  });

  it('still notifies locally when Telegram is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: '123:ABC', chatId: 4242 });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messages()).toEqual(['Weekly usage 82% — 4 days to reset.']);
  });

  it('does not retry a rate-limited send', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: '123:ABC', chatId: 4242 });

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    // One attempt, then silence. A late warning is worse than a missing one and
    // a retry storm is how a bot gets itself rate limited.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ---- Robustness ---------------------------------------------------------- */

describe('malformed input', () => {
  it('does not throw on anything storage might hold', async () => {
    settings();

    const rubbish: unknown[] = [
      undefined,
      null,
      42,
      'a string',
      {},
      { windows: 'not an array' },
      { windows: [null, 7, {}, { key: '' }, { key: '7d', utilization: 'lots' }] },
      { windows: [{ key: '7d', utilization: Number.NaN, resetsAt: 'thursday' }] },
    ];

    for (const value of rubbish) {
      await expect(evaluateSnapshotChange(value, value, NOW)).resolves.toBeUndefined();
    }

    expect(fake.notifications).toHaveLength(0);
  });

  it('survives an alert log full of junk', async () => {
    settings();
    fake.store.set(KEYS.alerts, ['nonsense', 3, null, { kind: 'threshold' }]);

    await evaluateSnapshotChange(undefined, snapshot([weekly(82, NOW + 4 * DAY)]), NOW);

    expect(fake.notifications).toHaveLength(1);
  });
});

/* ---- The subscription ---------------------------------------------------- */

describe('initAlerts', () => {
  it('dispatches from a storage write', async () => {
    settings();
    initAlerts();

    expect(fake.storageListenerCount()).toBe(1);

    await chrome.storage.local.set({
      [KEYS.snapshot]: snapshot([weekly(95, NOW + 2 * DAY)]),
    });
    await flush();

    expect(fake.notifications).toHaveLength(1);
  });

  it('ignores writes to other keys', async () => {
    settings();
    initAlerts();

    await chrome.storage.local.set({ [KEYS.status]: { kind: 'ok', at: NOW } });
    await flush();

    expect(fake.notifications).toHaveLength(0);
  });
});

/* ---- The connect flow ---------------------------------------------------- */

describe('the connect flow', () => {
  /** Drive the listener the way Chrome does, and resolve with what it replies. */
  function ask(message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const claimed = handleTelegramMessage(
        message,
        {} as chrome.runtime.MessageSender,
        resolve as (response: unknown) => void,
      );
      if (!claimed) resolve('not claimed');
    });
  }

  async function storedSettings(): Promise<Settings> {
    return (await chrome.storage.local.get(KEYS.settings))[KEYS.settings] as Settings;
  }

  /** getMe then getUpdates, in that order. */
  function telegram(getMe: unknown, getUpdates: unknown) {
    return vi.fn(async (url: string) => {
      const body = url.includes('getMe') ? getMe : getUpdates;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  const ME = { ok: true, result: { username: 'my_wick_bot' } };
  const CHAT = {
    ok: true,
    result: [{ update_id: 7, message: { chat: { id: 4242, username: 'someone' } } }],
  };

  it('verifies the token, discovers the chat, and stores both', async () => {
    const fetchMock = telegram(ME, CHAT);
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: null, chatId: null, chatLabel: null });

    expect(await ask({ type: 'wick:telegram-connect', botToken: '123:ABC' })).toEqual({
      ok: true,
      outcome: 'ok',
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe(`${TELEGRAM_ORIGIN}/bot123:ABC/getMe`);
    expect(urls[1]).toBe(`${TELEGRAM_ORIGIN}/bot123:ABC/getUpdates`);

    const saved = await storedSettings();
    expect(saved.botToken).toBe('123:ABC');
    // Discovered, never typed. Asking a user for a numeric chat id is the worst
    // part of every bot integration.
    expect(saved.chatId).toBe(4242);
    expect(saved.chatLabel).toBe('@someone');
  });

  it('takes the most recent message when several are waiting', async () => {
    // A user retrying after a failed attempt has a backlog; the newest is the
    // one they just sent.
    vi.stubGlobal(
      'fetch',
      telegram(ME, {
        ok: true,
        result: [
          { update_id: 3, message: { chat: { id: 111, username: 'stale' } } },
          { update_id: 9, message: { chat: { id: 999, username: 'newest' } } },
          { update_id: 5, message: { chat: { id: 555, username: 'middle' } } },
        ],
      }),
    );
    settings({ botToken: null, chatId: null });

    await ask({ type: 'wick:telegram-connect', botToken: '123:ABC' });

    expect((await storedSettings()).chatId).toBe(999);
  });

  it('reports a token Telegram refuses, and writes nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    settings({ botToken: null, chatId: null });

    expect(await ask({ type: 'wick:telegram-connect', botToken: 'nope' })).toEqual({
      ok: true,
      outcome: 'bad-token',
    });
    expect((await storedSettings()).botToken).toBeNull();
  });

  it('keeps a verified token when there is no chat yet, so nothing is re-typed', async () => {
    // The commonest first attempt: the token is fine, but Telegram will not let
    // a bot message someone who has not written to it. Discarding a 46-character
    // token over a step the user has simply not done yet would be a bad trade.
    vi.stubGlobal('fetch', telegram(ME, { ok: true, result: [] }));
    settings({ botToken: null, chatId: null });

    expect(await ask({ type: 'wick:telegram-connect', botToken: '123:ABC' })).toEqual({
      ok: true,
      outcome: 'no-chat',
    });

    const saved = await storedSettings();
    expect(saved.botToken).toBe('123:ABC');
    // But not connected: chatId is what everything else reads.
    expect(saved.chatId).toBeNull();
    expect(saved.chatLabel).toBe('@my_wick_bot');
  });

  it('finishes from the stored token once the user has messaged the bot', async () => {
    const fetchMock = telegram(ME, CHAT);
    vi.stubGlobal('fetch', fetchMock);
    // Where the previous test left off.
    settings({ botToken: '123:ABC', chatId: null, chatLabel: '@my_wick_bot' });

    expect(await ask({ type: 'wick:telegram-finish' })).toEqual({ ok: true, outcome: 'ok' });

    const saved = await storedSettings();
    expect(saved.chatId).toBe(4242);
    expect(saved.chatLabel).toBe('@someone');
  });

  it('sends a message on success, because storage is not proof', async () => {
    // A settings screen saying "Connected" has only proved it can write to its
    // own storage. A message landing in Telegram is the evidence the user wants.
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).includes('getUpdates')) {
        return new Response(JSON.stringify(CHAT), { status: 200 });
      }
      if (String(url).includes('sendMessage')) {
        sent.push(String((JSON.parse(String(init.body)) as { text: string }).text));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    settings({ botToken: '123:ABC', chatId: null });

    await ask({ type: 'wick:telegram-finish' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Wick is connected');
  });

  it('still connects when the confirmation message cannot be delivered', async () => {
    // The connection is real even if one message did not land. Failing here
    // would tell the user to redo something already done.
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('sendMessage')) throw new Error('offline');
      return new Response(JSON.stringify(CHAT), { status: 200 });
    });
    settings({ botToken: '123:ABC', chatId: null });

    expect(await ask({ type: 'wick:telegram-finish' })).toEqual({ ok: true, outcome: 'ok' });
    expect((await storedSettings()).chatId).toBe(4242);
  });

  it('never leaves a stored chat when the lookup fails', async () => {
    // The token may be kept; a chat may not. Half-connected is allowed only in
    // the direction that cannot silently swallow an alert.
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('getMe')) return new Response(JSON.stringify(ME), { status: 200 });
      throw new Error('offline');
    });
    settings({ botToken: null, chatId: null });

    expect(await ask({ type: 'wick:telegram-connect', botToken: '123:ABC' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });

    expect((await storedSettings()).chatId).toBeNull();
  });

  it('reports unreachable Telegram as unavailable, and writes nothing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    settings({ botToken: null, chatId: null });

    expect(await ask({ type: 'wick:telegram-connect', botToken: '123:ABC' })).toEqual({
      ok: true,
      outcome: 'unavailable',
    });
    expect((await storedSettings()).botToken).toBeNull();
  });

  it('forgets locally on disconnect, and tells nobody', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    settings({ botToken: '123:ABC', chatId: 4242, chatLabel: '@someone' });

    expect(await ask({ type: 'wick:telegram-disconnect' })).toEqual({ ok: true });

    // There is nothing to revoke: the bot belongs to the user, and Wick
    // forgetting a token does not invalidate it. Killing it is @BotFather's job.
    expect(fetchMock).not.toHaveBeenCalled();

    const saved = await storedSettings();
    expect(saved.botToken).toBeNull();
    expect(saved.chatId).toBeNull();
    expect(saved.chatLabel).toBeNull();
  });

  it("leaves the collector's messages alone", async () => {
    settings();

    // Returning `true` for one of these would hold the reply port open for an
    // answer this module never sends.
    expect(await ask({ type: 'wick:refresh' })).toBe('not claimed');
    expect(await ask({ type: 'wick:get-state' })).toBe('not claimed');
    expect(await ask({ nonsense: true })).toBe('not claimed');
  });
});

/* ---- Copy ---------------------------------------------------------------- */

describe('message composition', () => {
  it('adds the pace line when there is a forecast', () => {
    const text = thresholdMessage(
      weekly(80, NOW + 4 * DAY),
      {
        exhaustionEstimate: NOW + 2 * DAY + 5 * HOUR,
        confidence: 'medium',
        pace: 27.6,
        reason: 'Seven days of history',
      },
      NOW,
    );

    const [headline, detail] = text.split('\n');
    expect(headline).toBe('Weekly usage 80% — 4 days to reset.');
    expect(detail).toMatch(/^pace 28\/day · runs out \w+ ~\d\d:\d\d$/);
  });

  it('omits the forecast clause when there is no estimate', () => {
    const text = thresholdMessage(
      weekly(80, NOW + 4 * DAY),
      { exhaustionEstimate: null, confidence: 'low', pace: 12, reason: 'Only 4 days of history' },
      NOW,
    );

    expect(text).toBe('Weekly usage 80% — 4 days to reset.\npace 12/day');
  });

  it('drops the whole detail line when the projection knows nothing', () => {
    const text = thresholdMessage(
      weekly(80, NOW + 4 * DAY),
      { exhaustionEstimate: null, confidence: 'none', pace: null, reason: 'No history yet' },
      NOW,
    );

    expect(text).toBe('Weekly usage 80% — 4 days to reset.');
  });

  it('counts down in hours inside a day', () => {
    const text = thresholdMessage(
      weekly(80, NOW + 6 * HOUR),
      { exhaustionEstimate: null, confidence: 'none', pace: null, reason: 'No history yet' },
      NOW,
    );

    expect(text).toBe('Weekly usage 80% — 6 hr to reset.');
  });

  it('says nothing about a reset time the provider did not give', () => {
    expect(resetMessage(limitWindow({ key: '5h', shortLabel: 'Session', utilization: null }))).toBe(
      'Session window reset.',
    );
  });

  it('says so plainly when last week had no messages', () => {
    expect(weeklySummaryMessage([], NOW)).toBe('Weekly reset. No messages recorded last week.');
  });
});

/* ---- Cycle keys ---------------------------------------------------------- */

describe('cycleKeyFor', () => {
  it('keys on the reset that ends the cycle', () => {
    const resetsAt = NOW + 4 * DAY;
    expect(cycleKeyFor(weekly(50, resetsAt), NOW)).toBe(`7d@${resetsAt}`);
  });

  it('falls back to the local date when the reset time is unknown', () => {
    // At worst one message per window per day, for a window whose shape the
    // provider did not report.
    expect(cycleKeyFor(limitWindow({ key: '7d' }), NOW)).toBe('7d@day:2026-08-24');
  });
});

describe('weeklyWindow', () => {
  it('picks the window that resets furthest out', () => {
    const chosen = weeklyWindow([session(30, NOW + 3 * HOUR), weekly(82, NOW + 4 * DAY)]);
    expect(chosen?.key).toBe('7d');
  });

  it('ignores inactive windows', () => {
    const chosen = weeklyWindow([
      session(30, NOW + 3 * HOUR),
      limitWindow({ key: 'overage', resetsAt: NOW + 30 * DAY, active: false }),
    ]);
    expect(chosen?.key).toBe('5h');
  });

  it('has nothing to say about an empty snapshot', () => {
    expect(weeklyWindow([])).toBeNull();
  });
});

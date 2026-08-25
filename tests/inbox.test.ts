import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseCommand, reply, type Readings } from '~/background/commands';
import { drainInbox, nextOffset } from '~/background/inbox';
import { KEYS } from '~/background/store';
import { DEFAULT_SETTINGS, type LimitWindow, type Snapshot } from '~/core/types';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const NOW = new Date(2026, 7, 24, 14, 0).getTime();
const DAY = 86_400_000;

let fake: FakeChrome;

beforeEach(() => {
  fake = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

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

const weekly = (utilization: number, resetsAt: number) =>
  limitWindow({ key: '7d', label: 'Weekly', shortLabel: 'Weekly', role: 'weekly', utilization, resetsAt });

const session = (utilization: number) =>
  limitWindow({
    key: '5h',
    label: 'Session · 5 hr',
    shortLabel: 'Session',
    role: 'session',
    utilization,
    resetsAt: NOW + 3_600_000,
  });

function snapshot(windows: LimitWindow[]): Snapshot {
  return { providerId: 'claude', accountId: null, windows, fetchedAt: NOW, source: 'usage' };
}

function rollup(date: string, messageCount: number, windows: Record<string, number> = {}) {
  return { date, windows, messageCount, hourlyMessages: new Array<number>(24).fill(0) };
}

function readings(over: Partial<Readings> = {}): Readings {
  return { snapshot: null, history: [], now: NOW, ...over };
}

/* ---- parsing -------------------------------------------------------------- */

describe('parseCommand', () => {
  it('reads the usage commands and their aliases', () => {
    expect(parseCommand('/weekly')).toBe('weekly');
    expect(parseCommand('/week')).toBe('weekly');
    expect(parseCommand('/daily')).toBe('daily');
    expect(parseCommand('/today')).toBe('daily');
    expect(parseCommand('/help')).toBe('help');
    expect(parseCommand('/start')).toBe('help');
  });

  it('strips the @botname suffix Telegram adds in groups', () => {
    expect(parseCommand('/weekly@my_wick_bot')).toBe('weekly');
  });

  it('treats plain conversation and unknown commands as unknown', () => {
    expect(parseCommand('hello')).toBe('unknown');
    expect(parseCommand('/nonsense')).toBe('unknown');
    expect(parseCommand('')).toBe('unknown');
  });
});

/* ---- replies -------------------------------------------------------------- */

describe('replies', () => {
  it('answers /weekly with the reading and the pace', () => {
    const text = reply('weekly', readings({ snapshot: snapshot([weekly(82, NOW + 4 * DAY)]) }));
    expect(text).toContain('Weekly usage 82%');
  });

  it('says it has no reading rather than reporting zero', () => {
    // The rule the whole project runs on: a number nobody measured is unknown,
    // not nought.
    const text = reply('weekly', readings());
    expect(text).toContain('No weekly reading yet');
    expect(text).not.toContain('0%');
  });

  it('reports a window with no percentage as unknown', () => {
    const bare = { ...weekly(0, NOW + DAY), utilization: null };
    const text = reply('weekly', readings({ snapshot: snapshot([bare]) }));
    expect(text).toContain('unknown');
  });

  it('answers /daily with the count and the current windows', () => {
    const text = reply(
      'daily',
      readings({
        snapshot: snapshot([session(31), weekly(82, NOW + 4 * DAY)]),
        history: [rollup('2026-08-24', 47, { '7d': 82 })],
      }),
    );

    expect(text).toContain('47 messages');
    expect(text).toContain('Session 31%');
    expect(text).toContain('Weekly 82%');
  });

  it('distinguishes a day not yet recorded from a day with nothing on it', () => {
    const text = reply('daily', readings());
    expect(text).toContain('Nothing recorded today yet');
  });

  it('singularises one message', () => {
    const text = reply(
      'daily',
      readings({ history: [rollup('2026-08-24', 1)] }),
    );
    expect(text).toContain('1 message.');
  });

  it('warns in the help that replies are neither instant nor always available', () => {
    // The limitation of having no server. Saying it here is the difference
    // between a known constraint and a bot that looks broken.
    const text = reply('help', readings());
    expect(text).toContain('/weekly');
    expect(text).toContain('/daily');
    expect(text.toLowerCase()).toContain('chrome has to be open');
  });

  it('shows the help when it does not understand', () => {
    expect(reply('unknown', readings())).toContain('/weekly');
  });
});

/* ---- offsets -------------------------------------------------------------- */

describe('nextOffset', () => {
  it('acknowledges by asking for one past the highest id', () => {
    expect(nextOffset([{ update_id: 10 }, { update_id: 12 }, { update_id: 11 }], 0)).toBe(13);
  });

  it('holds position when nothing arrived', () => {
    expect(nextOffset([], 7)).toBe(7);
  });
});

/* ---- draining ------------------------------------------------------------- */

describe('drainInbox', () => {
  function connect(over: Record<string, unknown> = {}) {
    fake.store.set(KEYS.settings, {
      ...DEFAULT_SETTINGS,
      botToken: '123:ABC',
      chatId: 4242,
      ...over,
    });
  }

  /** getUpdates returns `updates`; sendMessage records what was sent. */
  function telegram(updates: unknown[]) {
    const sent: Array<{ chatId: unknown; text: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('getUpdates')) {
        return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as { chat_id: unknown; text: string };
      sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { sent, fetchMock };
  }

  it('does nothing at all when Telegram is not set up', async () => {
    const { fetchMock } = telegram([]);
    fake.store.set(KEYS.settings, { ...DEFAULT_SETTINGS, botToken: null, chatId: null });

    await drainInbox();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a command from the connected chat', async () => {
    connect();
    fake.store.set(KEYS.snapshot, snapshot([weekly(82, NOW + 4 * DAY)]));
    const { sent } = telegram([
      { update_id: 5, message: { text: '/weekly', chat: { id: 4242 } } },
    ]);

    await drainInbox();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(4242);
    expect(sent[0]?.text).toContain('Weekly usage 82%');
  });

  it('ignores a message from any chat but the connected one', async () => {
    // A bot username is public and anyone who finds it can write to it.
    // Answering whoever asked would hand a stranger this user's usage figures.
    connect();
    fake.store.set(KEYS.snapshot, snapshot([weekly(82, NOW + 4 * DAY)]));
    const { sent } = telegram([
      { update_id: 5, message: { text: '/weekly', chat: { id: 9999 } } },
      { update_id: 6, message: { text: '/daily', chat: { id: 4242 } } },
    ]);

    await drainInbox();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(4242);
  });

  it('records the offset before replying, so nothing is answered twice', async () => {
    connect();
    telegram([{ update_id: 5, message: { text: '/help', chat: { id: 4242 } } }]);

    await drainInbox();

    expect(fake.store.get(KEYS.inbox)).toBe(6);
  });

  it('asks from the stored offset', async () => {
    connect();
    fake.store.set(KEYS.inbox, 42);
    const { fetchMock } = telegram([]);

    await drainInbox();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['offset']).toBe(42);
    // Not a long poll: an MV3 worker torn down mid-wait would hold nothing.
    expect(body['timeout']).toBe(0);
  });

  it('sends nothing when the queue is empty', async () => {
    connect();
    const { sent } = telegram([]);

    await drainInbox();

    expect(sent).toHaveLength(0);
  });

  it('survives Telegram being unreachable', async () => {
    connect();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });

    await expect(drainInbox()).resolves.toBeUndefined();
    // The offset is untouched, so the next tick retries the same updates.
    expect(fake.store.get(KEYS.inbox)).toBeUndefined();
  });
});

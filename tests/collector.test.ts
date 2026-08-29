/**
 * The collector, against the fake extension host.
 *
 * The property under test throughout is the one the rest of the background
 * depends on: whatever claude.ai does — no cookie, a moved endpoint, a network
 * that is not there — `poll` resolves and the store ends up holding an honest
 * account of what happened. A rejection here is a service worker that stops
 * polling, which the user experiences as a number that quietly stops moving.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';
import type { RuntimeResponse } from '~/core/messages';
import type { DailyRollup, Snapshot } from '~/core/types';
import { ACTIVE_INTERVAL_MINUTES, POLL_ALARM, IDLE_INTERVAL_MINUTES } from '~/background/alarms';
import {
  handleRuntimeMessage,
  initCollector,
  poll,
  resetCollectorMemory,
} from '~/background/collector';
import { KEYS, readState } from '~/background/store';
import { resetUsagePathMemo } from '~/providers/claude';

let fake: FakeChrome;
const realFetch = globalThis.fetch;

/**
 * Time is faked and pushed forward between tests, because the collector holds
 * module-level state — the invalidation rate limit, the probed endpoint path —
 * that a real clock would carry from one test into the next.
 */
let now = Date.UTC(2026, 7, 24, 12, 0, 0);

/** Every URL `fetch` was called with, in order. */
let requested: string[] = [];

function stubFetch(handler: (url: string) => Response): void {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(String(input));
    return Promise.resolve(handler(String(input)));
  }) as typeof fetch;
}

function usageResponse(percent: number, key = '5h'): Response {
  return new Response(
    JSON.stringify({ limits: [{ kind: key, percent, severity: 'ok', is_active: true }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function storedSnapshot(): Snapshot | undefined {
  return fake.store.get(KEYS.snapshot) as Snapshot | undefined;
}

function storedHistory(): DailyRollup[] {
  return (fake.store.get(KEYS.history) as DailyRollup[] | undefined) ?? [];
}

/** Drive the message listener directly, and hold it to its reply contract. */
function ask(
  message: unknown,
  sender?: chrome.runtime.MessageSender,
): Promise<RuntimeResponse | undefined> {
  const type = (message as { type?: unknown } | null)?.type;
  const contentOrigin =
    type === 'wick:stream-limits' || type === 'wick:message-sent' || type === 'wick:tab-open';
  const actualSender = sender ?? (contentOrigin ? fake.contentSender() : fake.popupSender());

  return new Promise((resolve) => {
    const keptOpen = handleRuntimeMessage(
      message,
      actualSender,
      resolve as (response: RuntimeResponse) => void,
    );
    // A listener that replies asynchronously must return true, or Chrome closes
    // the channel and the reply lands nowhere.
    if (!keptOpen) resolve(undefined);
  });
}

beforeEach(() => {
  fake = installChromeMock();
  fake.reset();
  resetUsagePathMemo();
  // The worker forgets these on teardown; one module instance shared across
  // cases does not.
  resetCollectorMemory();
  now += 60 * 60 * 1000;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  stubFetch(() => new Response('', { status: 404 }));
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  uninstallChromeMock();
});

describe('poll', () => {
  it('reports signed-out and writes nothing when there is no organisation cookie', async () => {
    await poll('alarm');

    expect(fake.store.get(KEYS.status)).toEqual({ kind: 'signed-out' });
    expect(storedSnapshot()).toBeUndefined();
    // Not even a probe: without an organisation there is no URL to probe.
    expect(requested).toHaveLength(0);
  });

  it('writes a snapshot, a rollup and an ok status on a successful poll', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(82) : new Response('', { status: 404 })));

    await poll('alarm');

    expect(storedSnapshot()).toEqual({
      providerId: 'claude',
      accountId: 'org-42',
      source: 'usage',
      fetchedAt: now,
      windows: [
        expect.objectContaining({
          key: '5h',
          utilization: 82,
          status: 'ok',
          // Stamped by the store as it merges, not by the provider.
          source: 'usage',
          observedAt: now,
        }),
      ],
    });
    expect(storedHistory()).toEqual([
      expect.objectContaining({ windows: { '5h': 82 }, messageCount: 0, accountId: 'org-42' }),
    ]);
    expect(fake.store.get(KEYS.status)).toEqual({ kind: 'ok', at: now });
  });

  it('keeps the peak of the day rather than the latest reading', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    let percent = 60;
    stubFetch((url) =>
      url.endsWith('/usage') ? usageResponse(percent) : new Response('', { status: 404 }),
    );

    await poll('alarm');
    percent = 40; // the window reset mid-day
    await poll('alarm');

    expect(storedHistory()[0]?.windows).toEqual({ '5h': 60 });
  });

  it('leaves an error status behind, and does not reject, when the fetch throws', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    globalThis.fetch = (() => Promise.reject(new Error('Failed to fetch'))) as typeof fetch;

    await expect(poll('alarm')).resolves.toBeUndefined();

    expect(fake.store.get(KEYS.status)).toEqual({
      kind: 'error',
      message: 'Failed to fetch',
      at: now,
    });
    expect(storedSnapshot()).toBeUndefined();
  });

  it('does not reject when reading the cookie throws', async () => {
    // Nothing in the collector's own code can produce this; the extension host
    // can, and the poll loop has to outlive it either way.
    const host = chrome as unknown as { cookies: { get: () => Promise<unknown> } };
    host.cookies.get = () => Promise.reject(new Error('host unavailable'));

    await expect(poll('alarm')).resolves.toBeUndefined();

    expect(fake.store.get(KEYS.status)).toMatchObject({ kind: 'error', message: 'host unavailable' });
  });

  it('reports a signed-out session when the endpoint refuses the credentials', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch(() => new Response('', { status: 403 }));

    await poll('alarm');

    expect(fake.store.get(KEYS.status)).toEqual({ kind: 'signed-out' });
  });

  it('reports an error, not an empty reading, when no candidate endpoint answers', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch(() => new Response('', { status: 404 }));

    await poll('alarm');

    // A wrong path guess must never look like "you have used nothing".
    expect(storedSnapshot()).toBeUndefined();
    expect(fake.store.get(KEYS.status)).toMatchObject({ kind: 'error' });
  });
});

describe('initCollector', () => {
  it('arms the poll alarm and polls when it fires', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(10) : new Response('', { status: 404 })));

    initCollector();
    await vi.waitFor(() => expect(fake.alarms.get(POLL_ALARM)).toBeDefined());

    // No claude.ai tab in the fake, so the idle cadence is the right one.
    expect(fake.alarms.get(POLL_ALARM)?.periodInMinutes).toBe(IDLE_INTERVAL_MINUTES);

    fake.fireAlarm(POLL_ALARM);
    await vi.waitFor(() => expect(storedSnapshot()).toBeDefined());
  });

  it('watches exactly the three documented cache-invalidation URLs', async () => {
    // Captured rather than asserted through the fake, which has no way to fire
    // a webRequest event. The filter is worth pinning: a typo in a match
    // pattern is silent, and the listener simply never fires again.
    let filter: chrome.webRequest.RequestFilter | undefined;
    let fired: (() => void) | undefined;
    chrome.webRequest.onCompleted.addListener = ((
      listener: () => void,
      requestFilter: chrome.webRequest.RequestFilter,
    ) => {
      fired = listener;
      filter = requestFilter;
    }) as typeof chrome.webRequest.onCompleted.addListener;

    initCollector();

    expect(filter?.urls).toEqual([
      'https://claude.ai/api/account_profile*',
      'https://claude.ai/api/account/settings*',
      'https://claude.ai/api/settings/billing*',
    ]);

    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(5) : new Response('', { status: 404 })));

    fired?.();
    await vi.waitFor(() => expect(storedSnapshot()).toBeDefined());

    // One account change fires several of the watched requests; they must not
    // become several fetches.
    requested.length = 0;
    fired?.();
    fired?.();
    await Promise.resolve();
    expect(requested).toHaveLength(0);
  });
});

describe('runtime messages', () => {
  it('ignores a message that is not one of Wick’s', async () => {
    await expect(ask({ type: 'something-else' })).resolves.toBeUndefined();
    await expect(ask(null)).resolves.toBeUndefined();
  });

  it('answers wick:get-state with the assembled state', async () => {
    const response = await ask({ type: 'wick:get-state' });

    expect(response).toMatchObject({ ok: true, state: { snapshot: null, history: [] } });
  });

  it('does not let an unconfirmed page completion create durable counts', async () => {
    await expect(
      ask({ type: 'wick:message-sent', at: now, id: 'req-1' }),
    ).resolves.toBeUndefined();

    expect(storedHistory()).toEqual([]);
    expect(fake.store.get(KEYS.boardLedger)).toBeUndefined();
  });

  it('polls on wick:refresh', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(44) : new Response('', { status: 404 })));

    await ask({ type: 'wick:refresh' });

    expect(storedSnapshot()?.source).toBe('usage');
  });

  it('does not let unconfirmed stream or refusal data create a snapshot or history', async () => {
    const windows = [
      { key: '5h', label: 'Session', shortLabel: 'Session', utilization: 51, status: 'ok', resetsAt: null, active: true, role: 'session' },
    ];

    await expect(
      ask({ type: 'wick:stream-limits', windows, at: now, source: 'stream' }),
    ).resolves.toBeUndefined();
    await expect(
      ask({ type: 'wick:stream-limits', windows, at: now, source: 'rejection' }),
    ).resolves.toBeUndefined();

    expect(storedSnapshot()).toBeUndefined();
    expect(storedHistory()).toEqual([]);
    expect(requested).toEqual([]);
  });

  it('keeps polling as the only authoritative percentage path', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(60) : new Response('', { status: 404 })));
    await poll('alarm');

    const forged = [
      { key: '5h', label: 'Session', shortLabel: 'Session', utilization: 99, status: 'ok', resetsAt: null, active: true, role: 'session' },
    ];
    await ask({ type: 'wick:stream-limits', windows: forged, at: now, source: 'stream' });

    expect(storedSnapshot()).toMatchObject({ source: 'usage', fetchedAt: now });
    expect(storedSnapshot()?.windows[0]?.utilization).toBe(60);
    expect(storedHistory()[0]?.windows).toEqual({ '5h': 60 });
  });

  it('rejects popup actions from a wrong extension id or non-extension URL', async () => {
    expect(
      await ask({ type: 'wick:get-state' }, { ...fake.popupSender(), id: 'other-extension' }),
    ).toBeUndefined();
    expect(
      await ask({ type: 'wick:get-state' }, fake.contentSender()),
    ).toBeUndefined();
  });

  it('rejects content actions from a wrong id, URL, or frame', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(20) : new Response('', { status: 404 })));

    for (const sender of [
      { ...fake.contentSender(), id: 'other-extension' },
      fake.contentSender('https://example.com/forged'),
      fake.contentSender('https://claude.ai/chats', 1),
      fake.popupSender(),
    ]) {
      expect(await ask({ type: 'wick:tab-open' }, sender)).toBeUndefined();
    }

    expect(storedSnapshot()).toBeUndefined();
  });
});

describe('coalescing', () => {
  it('answers concurrent triggers with one round of requests', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(30) : new Response('', { status: 404 })));

    await Promise.all([poll('alarm'), poll('refresh'), poll('tab')]);

    // Three triggers, one answer. Without this they stack: several requests for
    // one number, and several writes racing to record it.
    expect(requested.filter((url) => url.endsWith('/usage'))).toHaveLength(1);
  });
});

describe('signing out', () => {
  it('stops showing the departed session’s numbers, and keeps the record', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(55) : new Response('', { status: 404 })));
    await poll('alarm');
    expect(storedSnapshot()).toBeDefined();

    fake.cookies.delete('lastActiveOrg');
    await poll('alarm');

    expect(fake.store.get(KEYS.status)).toEqual({ kind: 'signed-out' });
    expect(storedSnapshot()).toBeUndefined();
    // History is the user's own record. Signing out is not a request to delete
    // it — nor to hide it, so the account tag stays and the panel can still
    // find the record it belongs to.
    expect(storedHistory()).toHaveLength(1);
    expect((await readState()).history).toHaveLength(1);
  });

  it('clears the snapshot when the endpoint refuses the credentials', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(55) : new Response('', { status: 404 })));
    await poll('alarm');

    stubFetch(() => new Response('', { status: 401 }));
    await poll('alarm');

    expect(storedSnapshot()).toBeUndefined();
  });
});

describe('a provider tab appearing', () => {
  it('moves to the attentive cadence and reads immediately', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(20) : new Response('', { status: 404 })));
    initCollector();
    fake.tabs.push({ url: 'https://claude.ai/chat/1' });

    await ask({ type: 'wick:tab-open' });

    expect(fake.alarms.get(POLL_ALARM)?.periodInMinutes).toBe(ACTIVE_INTERVAL_MINUTES);
    expect(storedSnapshot()?.windows[0]?.utilization).toBe(20);
  });
});

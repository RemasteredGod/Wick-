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
import { POLL_ALARM, IDLE_INTERVAL_MINUTES } from '~/background/alarms';
import { handleRuntimeMessage, initCollector, poll } from '~/background/collector';
import { KEYS } from '~/background/store';
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
function ask(message: unknown): Promise<RuntimeResponse | undefined> {
  return new Promise((resolve) => {
    const keptOpen = handleRuntimeMessage(
      message,
      {} as chrome.runtime.MessageSender,
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
      source: 'usage',
      fetchedAt: now,
      windows: [expect.objectContaining({ key: '5h', utilization: 82, status: 'ok' })],
    });
    expect(storedHistory()).toEqual([
      expect.objectContaining({ windows: { '5h': 82 }, messageCount: 0 }),
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

  it('counts a message into today’s rollup', async () => {
    await ask({ type: 'wick:message-sent', at: now });

    expect(storedHistory()[0]?.messageCount).toBe(1);
    expect(storedHistory()[0]?.hourlyMessages[new Date(now).getHours()]).toBe(1);
  });

  it('polls on wick:refresh', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(44) : new Response('', { status: 404 })));

    await ask({ type: 'wick:refresh' });

    expect(storedSnapshot()?.source).toBe('usage');
  });

  it('accepts a stream reading when nothing authoritative has been written', async () => {
    const windows = [
      { key: '5h', label: 'Session', shortLabel: 'Session', utilization: 51, status: 'ok', resetsAt: null, active: true },
    ];

    await ask({ type: 'wick:stream-limits', windows, at: now });

    expect(storedSnapshot()).toMatchObject({ source: 'stream', fetchedAt: now });
    expect(storedHistory()[0]?.windows).toEqual({ '5h': 51 });
  });

  it('does not let a stream reading overwrite a newer authoritative snapshot', async () => {
    fake.cookies.set('lastActiveOrg', 'org-42');
    stubFetch((url) => (url.endsWith('/usage') ? usageResponse(60) : new Response('', { status: 404 })));
    await poll('alarm');

    const stale = [
      { key: '5h', label: 'Session', shortLabel: 'Session', utilization: 99, status: 'ok', resetsAt: null, active: true },
    ];
    await ask({ type: 'wick:stream-limits', windows: stale, at: now - 1_000 });

    expect(storedSnapshot()).toMatchObject({ source: 'usage', fetchedAt: now });
    expect(storedSnapshot()?.windows[0]?.utilization).toBe(60);
    // And the refused reading must not sneak into the rollup either, where the
    // peak would preserve it long after the snapshot rejected it.
    expect(storedHistory()[0]?.windows).toEqual({ '5h': 60 });
  });
});

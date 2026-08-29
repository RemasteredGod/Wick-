import { afterEach, describe, expect, it, vi } from 'vitest';
import { initBridge } from '~/content/bridge';
import { INJECT_SOURCE, isInjectMessage, isRuntimeMessage } from '~/core/messages';

const NOW = Date.parse('2026-08-29T00:00:00Z');

function limitWindow() {
  return {
    key: '5h',
    label: 'Session',
    shortLabel: 'Session',
    utilization: 50,
    status: 'ok',
    resetsAt: NOW + 60_000,
    active: true,
    role: 'session',
  };
}

describe('MAIN-world message validation', () => {
  it('accepts only the exact bounded shape for each kind', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      isInjectMessage({ source: INJECT_SOURCE, kind: 'message-sent', at: NOW, id: 'req-1' }),
    ).toBe(true);
    expect(
      isInjectMessage({ source: INJECT_SOURCE, kind: 'refused', at: NOW, body: '{}' }),
    ).toBe(true);
    expect(
      isInjectMessage({ source: INJECT_SOURCE, kind: 'limits', at: NOW, event: { type: 'x' } }),
    ).toBe(true);

    for (const malformed of [
      { source: INJECT_SOURCE, kind: 'message-sent', at: NOW },
      { source: INJECT_SOURCE, kind: 'message-sent', at: NOW, id: '' },
      { source: INJECT_SOURCE, kind: 'message-sent', at: NOW, id: 'x'.repeat(129) },
      { source: INJECT_SOURCE, kind: 'message-sent', at: Number.NaN, id: 'req' },
      { source: INJECT_SOURCE, kind: 'message-sent', at: NOW, id: 'req', extra: true },
      { source: INJECT_SOURCE, kind: 'refused', at: NOW, body: { forged: true } },
      { source: INJECT_SOURCE, kind: 'refused', at: NOW, body: 'x'.repeat(65_537) },
      {
        source: INJECT_SOURCE,
        kind: 'limits',
        at: NOW,
        event: { first: 'x'.repeat(40_000), second: 'x'.repeat(40_000) },
      },
      { source: INJECT_SOURCE, kind: 'limits', at: NOW, event: () => undefined },
      { source: INJECT_SOURCE, kind: 'other', at: NOW },
    ]) {
      expect(isInjectMessage(malformed), JSON.stringify(malformed)).toBe(false);
    }

    vi.useRealTimers();
  });

  it('rejects stale and implausibly future page timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      isInjectMessage({ source: INJECT_SOURCE, kind: 'message-sent', at: NOW - 10 * 60_000, id: 'old' }),
    ).toBe(false);
    expect(
      isInjectMessage({ source: INJECT_SOURCE, kind: 'message-sent', at: NOW + 2 * 60_000, id: 'future' }),
    ).toBe(false);

    vi.useRealTimers();
  });
});

describe('runtime message validation', () => {
  it('validates exact no-payload actions', () => {
    for (const type of [
      'wick:refresh',
      'wick:tab-open',
      'wick:get-state',
      'wick:board-enroll',
      'wick:board-leave',
      'wick:read-account',
    ]) {
      expect(isRuntimeMessage({ type }), type).toBe(true);
      expect(isRuntimeMessage({ type, forged: true }), type).toBe(false);
    }
  });

  it('accepts nullable bounded account observations and rejects malformed ones', () => {
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'Ash@Example.com' })).toBe(true);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: null })).toBe(true);
    expect(isRuntimeMessage({ type: 'wick:account-email' })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 42 })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'a'.repeat(321) })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'missing-domain@' })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: '@missing-local.example' })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'two@@example.com' })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'space in@example.com' })).toBe(false);
    expect(isRuntimeMessage({ type: 'wick:account-email', email: 'a@example.com', extra: true })).toBe(false);
  });

  it('narrowly validates deprecated untrusted stream hints', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    expect(
      isRuntimeMessage({
        type: 'wick:stream-limits',
        windows: [limitWindow()],
        at: NOW,
        source: 'stream',
      }),
    ).toBe(true);
    expect(isRuntimeMessage({ type: 'wick:message-sent', at: NOW, id: 'req-1' })).toBe(true);

    for (const malformed of [
      { type: 'wick:message-sent', at: NOW, id: '' },
      { type: 'wick:message-sent', at: Infinity, id: 'req' },
      { type: 'wick:stream-limits', windows: [], at: NOW, source: 'stream' },
      { type: 'wick:stream-limits', windows: [{ ...limitWindow(), utilization: 101 }], at: NOW, source: 'stream' },
      { type: 'wick:stream-limits', windows: [{ ...limitWindow(), status: 'forged' }], at: NOW, source: 'stream' },
      { type: 'wick:stream-limits', windows: [{ ...limitWindow(), extra: true }], at: NOW, source: 'stream' },
      { type: 'wick:stream-limits', windows: [limitWindow()], at: NOW, source: 'usage' },
    ]) {
      expect(isRuntimeMessage(malformed), JSON.stringify(malformed)).toBe(false);
    }

    vi.useRealTimers();
  });
});



afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('page bridge trust', () => {
  it('sinks forged and structurally valid MAIN-world completion hints', () => {
    let listener: ((event: MessageEvent) => void) | undefined;
    const sent: unknown[] = [];
    const fakeWindow = {
      location: { origin: 'https://claude.ai' },
      addEventListener(type: string, callback: (event: MessageEvent) => void) {
        if (type === 'message') listener = callback;
      },
    };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage(message: unknown) {
          sent.push(message);
          return Promise.resolve();
        },
      },
    });

    initBridge();
    expect(sent).toEqual([{ type: 'wick:tab-open' }]);

    for (const data of [
      { source: INJECT_SOURCE, kind: 'message-sent', at: Date.now(), id: 'forged' },
      { source: INJECT_SOURCE, kind: 'limits', at: Date.now(), event: { type: 'message_limit' } },
      { source: INJECT_SOURCE, kind: 'refused', at: Date.now(), body: '{}' },
      { source: INJECT_SOURCE, kind: 'message-sent', at: Number.NaN, id: 'malformed' },
    ]) {
      listener?.({ source: fakeWindow, origin: fakeWindow.location.origin, data } as unknown as MessageEvent);
    }

    // The public source tag and even a narrow payload authenticate nothing.
    expect(sent).toEqual([{ type: 'wick:tab-open' }]);
  });
});

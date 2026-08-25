/**
 * The bridge between the page and the service worker.
 *
 * The MAIN-world wrapper is registered directly by the manifest. This isolated
 * content script validates what the wrapper posts, translates surviving values
 * into `RuntimeMessage`s, and forwards them to the worker.
 *
 * **Nothing from the page is trusted.** `window.postMessage` is a public
 * channel — claude.ai itself, and every other extension on the tab, can post
 * anything into it wearing Wick's tag. So every message is narrowed by
 * `isInjectMessage` and then re-parsed here through the provider's own parsers
 * rather than taken at its word.
 *
 * **Fail quiet.** Wick is a guest on someone else's page. Every entry point is
 * wrapped; a failure here shows up as no data, never as a broken claude.ai.
 */

import { isInjectMessage, type RuntimeMessage } from '~/core/messages';
import type { LimitWindow } from '~/core/types';
import { claudeProvider, limitWindowsFromRefusal } from '~/providers/claude';

/** Start bridging. The content-script entry point calls this once per page. */
export function initBridge(): void {
  try {
    window.addEventListener('message', onPageMessage);
  } catch {
    // No bridge, no stream readings. Polling still works.
  }

  // This script running at all means a provider tab is open, which is the one
  // fact the worker cannot learn on its own without asking for the `tabs`
  // permission. It is worth a message: the cadence and the first reading both
  // depend on it, and the alternative is waiting out an idle interval while the
  // user watches a stale number.
  send({ type: 'wick:tab-open' });
}

function onPageMessage(event: MessageEvent): void {
  try {
    // Only this window's own frame, and only its own origin. Neither check is
    // sufficient alone, and neither is expensive.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const message = event.data as unknown;
    if (!isInjectMessage(message)) return;

    switch (message.kind) {
      case 'limits':
        forwardWindows(claudeProvider.parseStreamEvent(message.event), message.at, 'stream');
        return;

      case 'refused':
        // Reported as what it is. A refusal is the server declining to do the
        // work, which is a stronger statement about a limit than a number read
        // off a stream, and the store ranks them accordingly.
        forwardWindows(limitWindowsFromRefusal(message.body), message.at, 'rejection');
        return;

      case 'message-sent':
        // The id comes from the page, so it is checked like everything else
        // from the page: a forged one costs at most one uncounted message.
        if (typeof message.id !== 'string' || message.id === '') return;
        send({ type: 'wick:message-sent', at: message.at, id: message.id });
        return;
    }
  } catch {
    // Guest rules.
  }
}

function forwardWindows(
  windows: LimitWindow[] | null,
  at: number,
  source: 'stream' | 'rejection',
): void {
  if (windows === null || windows.length === 0) return;
  send({ type: 'wick:stream-limits', windows, at, source });
}

function send(message: RuntimeMessage): void {
  try {
    // The worker may be starting, or the extension may have been reloaded out
    // from under this page. Both reject, and neither is worth reporting.
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Context invalidated: `sendMessage` throws synchronously for that one.
  }
}

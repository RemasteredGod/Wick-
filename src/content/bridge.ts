/**
 * The bridge between the page and the service worker.
 *
 * Three things happen here, none of them clever: the MAIN-world wrapper is
 * injected, what it posts back is validated, and what survives validation is
 * translated into `RuntimeMessage`s and forwarded.
 *
 * **Nothing from the page is trusted.** `window.postMessage` is a public
 * channel — claude.ai itself, and every other extension on the tab, can post
 * anything into it wearing Wick's tag. So every message is narrowed by
 * `isInjectMessage` and then re-parsed here through the provider's own parsers
 * rather than taken at its word. The worst a forged message can achieve is a
 * briefly wrong number that the next authoritative fetch overwrites, and that
 * is only true because the parsing happens on this side.
 *
 * **Fail quiet.** Wick is a guest on someone else's page. Every entry point is
 * wrapped; a failure here shows up as no data, never as a broken claude.ai.
 */

import { isInjectMessage, type RuntimeMessage } from '~/core/messages';
import type { LimitWindow } from '~/core/types';
import { claudeProvider, limitWindowsFromRefusal } from '~/providers/claude';

/** Path of the MAIN-world script, as declared in the manifest. */
const INJECT_PATH = 'src/content/inject.ts';

/** Start bridging. Safe to call once; a second call is ignored by the page flag. */
export function initBridge(): void {
  try {
    window.addEventListener('message', onPageMessage);
    injectWrapper();
  } catch {
    // No bridge, no stream readings. Polling still works.
  }
}

/**
 * Load the wrapper into the page's own world.
 *
 * A `<script src>` rather than inline text, because claude.ai serves a
 * content-security policy that refuses inline script — the extension's own
 * resource URL is allowed by the `web_accessible_resources` entry. It is
 * removed once loaded: the element has done its work, and leaving it in the
 * DOM makes Wick visible to anything walking the document.
 */
function injectWrapper(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(INJECT_PATH);
  script.type = 'module';
  script.addEventListener('load', () => script.remove());
  script.addEventListener('error', () => script.remove());
  document.documentElement.append(script);
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
        forwardWindows(claudeProvider.parseStreamEvent(message.event), message.at);
        return;

      case 'refused':
        // A refusal is lower trust than a fetch and higher trust than nothing,
        // which is exactly what the stream message already means to the store.
        forwardWindows(limitWindowsFromRefusal(message.body), message.at);
        return;

      case 'message-sent':
        send({ type: 'wick:message-sent', at: message.at });
        return;
    }
  } catch {
    // Guest rules.
  }
}

function forwardWindows(windows: LimitWindow[] | null, at: number): void {
  if (windows === null || windows.length === 0) return;
  send({ type: 'wick:stream-limits', windows, at });
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

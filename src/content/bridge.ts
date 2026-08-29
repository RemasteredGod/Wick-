/**
 * Isolated-world bridge.
 *
 * `window.postMessage` is public to the page and every extension with code in
 * the tab. The injected source tag is therefore routing metadata only. Until a
 * completion signal is verified from repository-owned evidence, MAIN-world
 * completion URLs, SSE/content-types, refusal bodies and timestamps are not
 * forwarded to the worker and can create no durable history, alerts or totals.
 */

import { isInjectMessage, type RuntimeMessage } from '~/core/messages';

/** Start bridging. The content-script entry point calls this once per page. */
export function initBridge(): void {
  try {
    window.addEventListener('message', onPageMessage);
  } catch {
    // Polling remains the authoritative percentage path.
  }

  // The isolated content script itself is trusted extension code. The worker
  // still validates its runtime sender id, provider URL and main-frame origin.
  send({ type: 'wick:tab-open' });
}

function onPageMessage(event: MessageEvent): void {
  try {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!isInjectMessage(event.data)) return;

    // Deliberate sink. Structural validation bounds hostile page input, but it
    // cannot authenticate it. Re-enable a specific forwarding path only after
    // live protocol verification establishes a signal the page cannot forge.
  } catch {
    // Guest rules: a hostile or malformed page message degrades to no hint.
  }
}

function send(message: RuntimeMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Context invalidated during navigation or extension reload.
  }
}

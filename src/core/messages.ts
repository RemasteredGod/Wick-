/**
 * Every message that crosses a boundary in Wick, in one file.
 *
 * There are three boundaries, and they do not use the same transport:
 *
 * 1. **MAIN world → content script.** `window.postMessage`, because the two
 *    share a page but not a JavaScript world. Anything on the page can post
 *    here, so these are validated on arrival, never trusted.
 * 2. **Content script → service worker.** `chrome.runtime.sendMessage`.
 * 3. **Popup ↔ service worker.** Same transport, opposite direction.
 *
 * The definitions live together so a change to one end cannot silently
 * disagree with the other.
 */

import type { LimitWindow, WickState } from './types';

/* ---- MAIN world → content script ---------------------------------------- */

/**
 * Tag on every message from the injected script.
 *
 * The page, and any other extension on it, can post whatever it likes into the
 * same channel. This tag plus `isInjectMessage` is the whole defence, and it is
 * enough because nothing here is privileged — the worst a forged message can do
 * is make Wick briefly display a wrong number, which the next authoritative
 * fetch corrects.
 */
export const INJECT_SOURCE = 'wick-inject' as const;

export type InjectMessage =
  /** A `message_limit` event was seen on a completion stream. */
  | { source: typeof INJECT_SOURCE; kind: 'limits'; event: unknown; at: number }
  /** A completion was started. Used for the daily message count. */
  | { source: typeof INJECT_SOURCE; kind: 'message-sent'; at: number }
  /** A send was refused for hitting a limit. Body is the refusal payload. */
  | { source: typeof INJECT_SOURCE; kind: 'refused'; body: unknown; at: number };

/** Narrow an arbitrary `MessageEvent.data` to something Wick posted. */
export function isInjectMessage(value: unknown): value is InjectMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<InjectMessage>;
  if (message.source !== INJECT_SOURCE) return false;
  return (
    message.kind === 'limits' || message.kind === 'message-sent' || message.kind === 'refused'
  );
}

/* ---- Content script / popup → service worker ---------------------------- */

export type RuntimeMessage =
  /**
   * Limit state read off a stream. Optimistic: it lands a second or two before
   * a fetch would, and the next authoritative fetch overrides it
   * unconditionally.
   */
  | { type: 'wick:stream-limits'; windows: LimitWindow[]; at: number }
  | { type: 'wick:message-sent'; at: number }
  /** Poll now. Sent when the popup opens, so it never shows a stale number. */
  | { type: 'wick:refresh' }
  | { type: 'wick:get-state' }
  /**
   * Redeem a connect code for a relay token.
   *
   * The popup collects the code and requests the host permission — that call
   * needs a user gesture and a service worker does not have one — but the
   * exchange itself happens in the worker, which owns the relay client and the
   * settings write. Presentation never fetches.
   */
  | { type: 'wick:relay-connect'; code: string }
  /** Revoke this installation's relay token and forget it locally. */
  | { type: 'wick:relay-disconnect' };

/**
 * How a connect attempt ended.
 *
 * A boundary type rather than a view type: the worker decides it, the settings
 * screen renders it, and neither gets to invent a value the other has not
 * heard of. Deliberately coarser than `RelayFailure` — the user can act on
 * "the code was stale" and on "grant the permission", and every remaining
 * failure is the same sentence to them.
 */
export type RelayConnectOutcome =
  | 'ok'
  /** Unknown, expired, or already spent. Far more often stale than mistyped. */
  | 'invalid-code'
  /** The relay could not be reached. */
  | 'unavailable'
  /** The user declined the host permission the relay call needs. */
  | 'not-permitted';

export type RuntimeResponse =
  | { ok: true; state: WickState }
  | { ok: true; outcome: RelayConnectOutcome }
  | { ok: true }
  | { ok: false; error: string };

/** Narrow an arbitrary `chrome.runtime` message. */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'wick:stream-limits' ||
    type === 'wick:message-sent' ||
    type === 'wick:refresh' ||
    type === 'wick:get-state' ||
    type === 'wick:relay-connect' ||
    type === 'wick:relay-disconnect'
  );
}

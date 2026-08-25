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
  /**
   * A completion was *accepted* — the server answered a send with a stream.
   *
   * Not "a request was made": a refused send and a failed one are neither of
   * them a message, and counting them inflates the only number on the panel
   * that claims to be a count of what the user did. `id` identifies the
   * request, so the same accepted completion observed twice is counted once.
   */
  | { source: typeof INJECT_SOURCE; kind: 'message-sent'; at: number; id: string }
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
   * Limit state read off the wire. Optimistic: it lands a second or two before
   * a fetch would, and the authoritative fetch that follows takes precedence
   * per window.
   *
   * `source` distinguishes the two ways this happens. A refusal is a stronger
   * statement than a stream event — the server has just declined to do the work
   * — and `SnapshotSource` has always had a name for it. The bridge used to
   * report both as `stream`, which made the distinction unusable.
   */
  | {
      type: 'wick:stream-limits';
      windows: LimitWindow[];
      at: number;
      source: 'stream' | 'rejection';
    }
  /** A completion the server accepted. `id` is per request, for de-duplication. */
  | { type: 'wick:message-sent'; at: number; id: string }
  /** Poll now. Sent when the popup opens, so it never shows a stale number. */
  | { type: 'wick:refresh' }
  /**
   * A provider tab has appeared.
   *
   * The poll cadence follows attention, and the worker cannot watch tabs open
   * without the `tabs` permission. The content script already runs on that
   * page, so it says so itself: no permission, and no polling for a tab that is
   * not there.
   */
  | { type: 'wick:tab-open' }
  | { type: 'wick:get-state' }
  /**
   * Verify a pasted bot token, find the chat, and store both.
   *
   * The popup collects the token and requests the host permission — that call
   * needs a user gesture and a service worker does not have one — but the two
   * Telegram calls and the settings write happen in the worker. Presentation
   * never fetches, and the token makes one trip across this boundary and is
   * never sent back.
   */
  | { type: 'wick:telegram-connect'; botToken: string }
  /** Forget the token and the chat. Nothing is revoked — see ADR 0009. */
  | { type: 'wick:telegram-disconnect' };

/**
 * How a connect attempt ended.
 *
 * A boundary type rather than a view type: the worker decides it, the settings
 * screen renders it, and neither gets to invent a value the other has not
 * heard of. Deliberately coarser than `TelegramFailure` — the user can act on
 * "message your bot first" and on "grant the permission", and every remaining
 * failure is the same sentence to them.
 */
export type ConnectOutcome =
  | 'ok'
  /** Telegram rejected the token: mistyped, or revoked in @BotFather. */
  | 'bad-token'
  /**
   * The token works, but the user has not messaged their bot — so there is no
   * chat to send to. The commonest outcome on a first attempt, and the one the
   * settings screen must explain rather than report.
   */
  | 'no-chat'
  /** Telegram could not be reached. */
  | 'unavailable'
  /** The user declined the host permission the call needs. */
  | 'not-permitted';

export type RuntimeResponse =
  | { ok: true; state: WickState }
  | { ok: true; outcome: ConnectOutcome }
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
    type === 'wick:tab-open' ||
    type === 'wick:get-state' ||
    type === 'wick:telegram-connect' ||
    type === 'wick:telegram-disconnect'
  );
}

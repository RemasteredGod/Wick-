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
   * Join the public leaderboard, or leave it.
   *
   * The popup collects the click; the worker owns the network call and the
   * settings write, because presentation never fetches. Enrolling asks the
   * board for a participant token and a name; leaving forgets both locally and
   * asks the board to delete the rows.
   */
  | { type: 'wick:board-enroll' }
  | { type: 'wick:board-leave' }
  /**
   * The signed-in Claude account, as read from claude.ai's sidebar.
   *
   * Sent by the content script whenever it sees one, and whenever it changes.
   * The board keys profiles on this, so it is what makes one account one public
   * profile across every browser — and what tells the worker that the user has
   * switched accounts and is now publishing as somebody else.
   */
  | { type: 'wick:account-email'; email: string }
  /**
   * Ask an open claude.ai tab which account is signed in, right now.
   *
   * The reverse direction of everything else here: worker to content script.
   * It exists because the account is only readable from the page, and Join is
   * pressed in the popup — which may happen before the content script's first
   * report, or with the last claude.ai tab already closed. Without this, the
   * worker's only options are a stale answer or none.
   */
  | { type: 'wick:read-account' };

/**
 * How a leaderboard action ended.
 *
 * A boundary type rather than a view type: the worker decides it, the settings
 * screen renders it, and neither gets to invent a value the other has not heard
 * of. Deliberately coarse — every failure the user can actually act on is
 * "try again later", and the rest is the same sentence to them.
 */
export type BoardOutcome =
  | 'ok'
  /**
   * Wick does not know which Claude account is signed in.
   *
   * Distinct from `unavailable`, and the distinction is the point: nothing is
   * broken and nothing is down. The board keys a profile on the account, and
   * the account is only readable from a claude.ai page — so the fix is a step
   * the user has not taken yet rather than a fault they can only wait out.
   * Reporting it as "could not reach the leaderboard" sent people to check a
   * server that was answering perfectly.
   */
  | 'no-account'
  /** The board could not be reached, or answered with an error. */
  | 'unavailable'
  /** The user declined the host permission the call needs. */
  | 'not-permitted';

export type RuntimeResponse =
  | { ok: true; state: WickState }
  | { ok: true; outcome: BoardOutcome }
  /** The answer to `wick:read-account`. `null` when the page does not say. */
  | { ok: true; email: string | null }
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
    type === 'wick:board-enroll' ||
    type === 'wick:board-leave' ||
    type === 'wick:account-email' ||
    type === 'wick:read-account'
  );
}

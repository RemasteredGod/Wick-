/**
 * MAIN-world fetch wrapper.
 *
 * Registered as a static MV3 content script with `world: 'MAIN'`, because it
 * has to see the `window.fetch` that claude.ai actually calls. Registering it
 * through the manifest also makes CRXJS emit executable JavaScript instead of
 * asking the page to load a `.ts` extension URL with an octet-stream MIME type.
 * MV3's `webRequest` cannot read response bodies at all, so observing the
 * `message_limit` event at the tail of a completion stream must happen here.
 *
 * Two rules govern everything this file does, and both are easy to get wrong:
 *
 * **Chain, never recurse.** Capture the existing `window.fetch` in a local and
 * call *that*. Calling `window.fetch` from inside the replacement recurses
 * infinitely the moment another extension patches the same function on the same
 * page — and on claude.ai, another extension usually has.
 *
 * **The tee is detached.** Clone the response and read the copy. Whatever
 * happens while parsing — a malformed record, a buffer cap, a thrown error —
 * must be invisible to the page. Wick observing a stream can never be the
 * reason a message fails to render. Nothing in the tee is ever awaited on the
 * path the page is waiting on.
 *
 * Two further hazards, recorded in the protocol notes and easy to be caught by:
 * records are right-padded with a variable run of spaces, so byte lengths are
 * not stable and nothing may key off them; and delivery is bursty, so an entire
 * short reply can arrive as a single delta. Hence a cap on the accumulated
 * buffer, and abandonment rather than silent truncation when it is hit.
 *
 * **What this file may import.** It executes in a page Wick does not own, so it
 * may only import modules that are pure at module scope: `~/core/messages` for
 * the tag, and the provider's parsers. Neither touches `chrome.*` or the store
 * on import, and the provider object itself is unreferenced here so it does not
 * survive bundling.
 */

import { INJECT_SOURCE, type InjectMessage } from '~/core/messages';
import { isCompletionUrl, limitWindowsFromEvent, parseSseChunk } from '~/providers/claude';

/**
 * Cap on the unterminated tail held between chunks, in characters.
 *
 * This is not a cap on the reply — complete records are parsed and dropped as
 * they arrive, so a long conversation never accumulates. It bounds only the
 * fragment Wick is still waiting for a blank line to finish. Two megabytes of
 * one unterminated record means the framing assumption in the protocol notes are
 * wrong, and a number read out of a stream that cannot be framed is worse than
 * no number: the authoritative poll is a minute away at most. So the stream is
 * abandoned, not truncated.
 */
const MAX_PENDING_CHARS = 2 * 1024 * 1024;

/** Set on the page so a second injection does not stack a second wrapper. */
const INSTALLED_FLAG = '__wickFetchWrapped';

install();

function install(): void {
  try {
    const flags = window as unknown as Record<string, unknown>;
    if (flags[INSTALLED_FLAG] === true) return;
    flags[INSTALLED_FLAG] = true;

    // Captured once, here. Every call goes through this local — never through
    // `window.fetch`, which by then is this very function.
    const originalFetch = window.fetch;

    window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
      const pending = originalFetch.call(window, ...args);

      try {
        const url = requestUrl(args[0]);
        if (url !== '' && isCompletionUrl(url)) {
          // Detached: a separate promise chain the page never sees or waits on.
          // Note what is *not* here: the message count. A request starting is
          // not a message — it may be refused for hitting the very limit Wick
          // is reporting on, or fail on the network — and counting one here
          // inflates the only figure on the panel that claims to count what the
          // user actually did. The count happens in `observe`, once the server
          // has answered with a stream.
          pending.then(observe, ignore).catch(ignore);
        }
      } catch {
        // The page's response is already in flight and unaffected.
      }

      return pending;
    };
  } catch {
    // A page that will not let its fetch be replaced gets no stream reading,
    // and Wick falls back to polling. It does not get a broken page.
  }
}

/** Read a copy of the response. Never touches the original. */
async function observe(response: Response): Promise<void> {
  let copy: Response;
  try {
    copy = response.clone();
  } catch {
    // Already consumed, or not cloneable. Nothing to do, and nothing broken.
    return;
  }

  const contentType = copy.headers.get('content-type') ?? '';

  // A refused send answers with JSON instead of a stream — the protocol notes
  // §"Rejection responses". Anything that is not a stream is treated as one of
  // those and handed over whole; deciding what it means is the bridge's job.
  if (!contentType.includes('text/event-stream')) {
    await readRefusal(copy);
    return;
  }

  // The server accepted the send and is answering with a stream. *That* is a
  // message. The id is per response, so the same one observed twice — a second
  // wrapper, a re-entered handler — is still one message.
  post({ source: INJECT_SOURCE, kind: 'message-sent', at: Date.now(), id: requestId() });

  await readStream(copy);
}

/**
 * An identifier for one accepted completion.
 *
 * `crypto.randomUUID` is not available on every page context Wick runs in —
 * it needs a secure context, and an extension cannot assume one — so the
 * fallback is not decoration. Collisions only matter within one worker's
 * memory of the last few sends, which makes this far more entropy than the job
 * needs.
 */
function requestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the arithmetic one.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readRefusal(response: Response): Promise<void> {
  const text = await response.text();
  if (text.trim() === '') return;
  post({ source: INJECT_SOURCE, kind: 'refused', body: text, at: Date.now() });
}

async function readStream(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });

    if (pending.length > MAX_PENDING_CHARS) {
      await reader.cancel().catch(ignore);
      return;
    }

    const { events, leftover } = parseSseChunk(pending);
    // The tail of a chunk is routinely half a record. It goes back on the front
    // of the next one; nothing here ever assumes a chunk is a record.
    pending = leftover;
    for (const event of events) emit(event.data);
  }

  pending += decoder.decode();

  // A stream that ended without its final blank line still owes us one record,
  // and the event Wick wants is the last one on the stream.
  const flushed = parseSseChunk(`${pending}\n\n`);
  for (const event of flushed.events) emit(event.data);
}

/**
 * Forward one parsed event, if it carries limit state.
 *
 * Filtered here rather than in the bridge because a completion stream is
 * hundreds of content deltas and one interesting record, and posting every
 * delta across the world boundary would cost more than reading the stream
 * saves. The bridge re-parses what arrives regardless — nothing from the page
 * is trusted, including this.
 */
function emit(data: unknown): void {
  if (limitWindowsFromEvent(data) === null) return;
  post({ source: INJECT_SOURCE, kind: 'limits', event: data, at: Date.now() });
}

function post(message: InjectMessage): void {
  try {
    window.postMessage(message, window.location.origin);
  } catch {
    // A value that will not structured-clone, or a page mid-navigation.
  }
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

function ignore(): void {
  // Named, so the empty handlers above read as deliberate rather than dropped.
}

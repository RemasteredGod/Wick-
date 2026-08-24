/**
 * MAIN-world fetch wrapper.
 *
 * Loaded into the page's own world, not the isolated content-script world,
 * because it has to see the `window.fetch` that claude.ai actually calls.
 * MV3's `webRequest` cannot read response bodies at all, so the only way to
 * observe the `message_limit` event at the tail of a completion stream is from
 * inside the page.
 *
 * Two rules govern everything this file will do, and both are easy to get
 * wrong:
 *
 * **Chain, never recurse.** Capture the existing `window.fetch` in a local and
 * call *that*. Calling `window.fetch` from inside the replacement recurses
 * infinitely the moment another extension patches the same function on the same
 * page — and on claude.ai, another extension usually has.
 *
 * **The tee is detached.** Clone the response and read the copy. Whatever
 * happens while parsing — a malformed record, a buffer cap, a thrown error —
 * must be invisible to the page. Wick observing a stream can never be the
 * reason a message fails to render.
 *
 * Two further hazards, recorded in docs/protocol.md and easy to be caught by:
 * records are right-padded with a variable run of spaces, so byte lengths are
 * not stable and nothing may key off them; and delivery is bursty, so an entire
 * short reply can arrive as a single delta. Cap the accumulated buffer and mark
 * the result unreliable rather than silently truncating it.
 *
 * Status: M3. This file is registered as a web-accessible resource now so the
 * manifest and the build are settled before the logic lands. It deliberately
 * does nothing yet — an unverified parser wrapping the page's fetch is a worse
 * outcome than no parser at all.
 */

export {};

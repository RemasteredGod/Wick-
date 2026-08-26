/**
 * The leaderboard client — the only module that talks to anything but claude.ai.
 *
 * Wick publishes one number per day: how many messages were sent. Not
 * percentages, which do not compare across plans; not tokens, which Wick has no
 * way to count and is forbidden from estimating (AGENTS.md, ADR 0001); and not
 * times of day, which the rollup holds and this module deliberately does not
 * read.
 *
 * **Opt-in, and inert until then.** `Settings.boardToken` is `null` on a fresh
 * install, every function below returns early when it is, and the origin sits
 * behind an optional host permission the popup asks for at the Join click. A
 * user who never joins never causes a request from here.
 *
 * **Only settled days are published.** Today is still accumulating, so sending
 * it would mean either publishing a number that goes stale within the hour or
 * resending the same day repeatedly. `boardSubmittedThrough` is the high-water
 * mark; the drain sends every complete day after it, oldest first, and advances
 * it only for days the board accepted.
 *
 * Every function returns rather than throwing. The board being down, slow, or
 * refusing must never break collection or the interface — this module rides the
 * poll alarm and a failure here costs one late submission and nothing else.
 */

import { localDateKey } from '~/core/normalise';
import { isRuntimeMessage, type BoardOutcome, type RuntimeResponse } from '~/core/messages';
import type { DailyRollup } from '~/core/types';
import { POLL_ALARM } from './alarms';
import { readAccountId, readHistory, readSettings, writeSettings } from './store';

/**
 * Where the board lives.
 *
 * **`www`, not the apex, and that is load-bearing.** `usewick.lol` answers 308
 * and redirects here. A 308 preserves the method and the body, so a submission
 * would survive it — but `www.usewick.lol` is a *different origin*, and `fetch`
 * strips the `Authorization` header across an origin-crossing redirect. Posting
 * through the apex would arrive unauthenticated and be refused as a 401 that
 * looks like a bad token. Naming the canonical host means never taking the
 * redirect.
 *
 * `BOARD_ORIGIN_PATTERN` must stay identical to `BOARD_MATCH` in
 * `src/manifest.ts` — a mismatch fails as an opaque network error rather than
 * as a permission error, which is a much harder thing to diagnose.
 * `tests/manifest.test.ts` asserts they agree.
 */
export const BOARD_ORIGIN = 'https://www.usewick.lol';
export const BOARD_ORIGIN_PATTERN = `${BOARD_ORIGIN}/*`;

/** How long a board call may take before it is abandoned. */
export const BOARD_TIMEOUT_MS = 10_000;

/**
 * Days of backlog one drain will publish.
 *
 * A machine that was closed for a fortnight has a fortnight of unsent days, and
 * sending all of them on the first alarm after it wakes is a burst the board
 * has no reason to absorb. Fourteen clears a typical gap in one pass and caps
 * the pathological one; the rest goes out on the next tick, a minute later.
 */
export const MAX_DRAIN_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * Register the listeners this module needs. Called once, synchronously.
 *
 * Rides the collector's poll alarm rather than creating one of its own. There
 * is nothing to publish that the collector has not already written, so a second
 * schedule would only mean waking the worker twice to do one job.
 */
export function initBoard(): void {
  chrome.runtime.onMessage.addListener(handleBoardMessage);

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    // Not awaited, and its rejection swallowed: an error escaping an alarm
    // handler takes the worker down with it, and a late submission is a much
    // smaller failure than a dead collector.
    void drain().catch(() => undefined);
  });
}

/* ---- Publishing ---------------------------------------------------------- */

/**
 * Publish every settled day the board has not seen.
 *
 * Oldest first, and stopping at the first refusal: the high-water mark is a
 * single date, so a gap in the middle of the run would either be lost or force
 * this to remember a set instead. Stopping keeps the invariant that everything
 * up to `boardSubmittedThrough` is published and everything after it is not.
 *
 * Exported for tests, which drive it directly rather than through an alarm.
 */
export async function drain(now = Date.now()): Promise<void> {
  const settings = await readSettings();
  const token = settings.boardToken;
  if (token === null) return;

  const pending = await pendingDays(settings.boardSubmittedThrough, now);

  for (const day of pending) {
    const accepted = await submit(token, day);
    if (!accepted) return;
    await writeSettings({ boardSubmittedThrough: day.date });
  }
}

/**
 * The settled days after the high-water mark, oldest first.
 *
 * Today is excluded because it is still accumulating. Days before the mark are
 * excluded because they are already published — and a day the user has *since*
 * accrued more messages on cannot be corrected, which is the price of a single
 * date as the bookmark and is worth it for how little it can go wrong.
 *
 * Exported for tests: which days are eligible is the part worth pinning down,
 * and it is decidable from a history array alone.
 */
export async function pendingDays(
  submittedThrough: string | null,
  now: number,
): Promise<DailyRollup[]> {
  // The signed-in account's own record. Publishing another organisation's day
  // under this participant's name would be wrong in both directions.
  const history = await readHistory(await readAccountId());
  const today = localDateKey(now);
  const earliest = localDateKey(now - MAX_DRAIN_DAYS * DAY_MS);

  return history
    .filter((day) => typeof day.date === 'string')
    .filter((day) => day.date !== today)
    .filter((day) => day.date >= earliest)
    .filter((day) => submittedThrough === null || day.date > submittedThrough)
    .filter((day) => Number.isFinite(day.messageCount) && day.messageCount >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Publish one day. `true` when the board took it.
 *
 * The body carries the date and the count, and that is the whole of it. There
 * is deliberately no window key, no utilization, no account id and no hourly
 * breakdown — the rollup holds all four and none of them is anyone else's
 * business. What is not sent cannot leak.
 */
async function submit(token: string, day: DailyRollup): Promise<boolean> {
  const result = await post('/api/submit', token, {
    day: day.date,
    messages: Math.round(day.messageCount),
  });
  return result !== null;
}

/* ---- Joining and leaving ------------------------------------------------- */

/**
 * Answer the two board messages. Returns `false` for anything else, so the
 * collector's listener still sees it.
 *
 * Exported for tests, which drive it directly: the reply is asynchronous, and
 * the reply is the whole point.
 */
export function handleBoardMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void,
): boolean {
  if (!isRuntimeMessage(message)) return false;

  if (message.type === 'wick:board-enroll') {
    void enroll()
      .then((outcome) => sendResponse({ ok: true, outcome }))
      .catch(() => sendResponse({ ok: true, outcome: 'unavailable' }));
    return true;
  }

  if (message.type === 'wick:board-leave') {
    void leave()
      .then((outcome) => sendResponse({ ok: true, outcome }))
      .catch(() => sendResponse({ ok: true, outcome: 'unavailable' }));
    return true;
  }

  return false;
}

/**
 * Ask the board for a participant token and a name.
 *
 * Nothing identifying is sent, because there is nothing to send: the board
 * mints the token and assigns the name, and the extension's only contribution
 * to its own identity is holding the token afterwards. That is the whole
 * anonymity argument, and it rests on this request having an empty body.
 *
 * Enrolling does **not** publish anything. The first submission happens on the
 * next poll alarm, for yesterday, which gives a user who joined by accident a
 * window in which leaving costs nothing.
 */
async function enroll(): Promise<BoardOutcome> {
  const { boardToken } = await readSettings();
  // Already joined. Minting a second token would orphan the first, and with it
  // every day published under it.
  if (boardToken !== null) return 'ok';

  const body = await post('/api/enroll', null, {});
  if (body === null) return 'unavailable';

  const token = stringField(body, 'token');
  const name = stringField(body, 'name');
  if (token === null || name === null) return 'unavailable';

  await writeSettings({ boardToken: token, boardName: name, boardSubmittedThrough: null });
  return 'ok';
}

/**
 * Leave: delete the published rows, then forget the token.
 *
 * In that order, and the order is the point. Forgetting first would leave rows
 * on the board that nothing holds the credential for any more — unreachable,
 * undeletable, and still on the public page under a name the user has been told
 * they gave up.
 *
 * A board that cannot be reached is reported as such and **nothing local is
 * cleared**, so pressing Leave again later still works.
 */
async function leave(): Promise<BoardOutcome> {
  const { boardToken } = await readSettings();
  if (boardToken === null) return 'ok';

  const body = await post('/api/leave', boardToken, {});
  if (body === null) return 'unavailable';

  await writeSettings({ boardToken: null, boardName: null, boardSubmittedThrough: null });
  return 'ok';
}

/* ---- Transport ----------------------------------------------------------- */

/**
 * POST JSON to the board. Returns the parsed body, or `null` for any failure.
 *
 * Never throws, and never distinguishes one failure from another to its caller.
 * There is exactly one thing a caller can do about a refused board call —
 * nothing, and try again on the next alarm — so a taxonomy of reasons would be
 * detail nobody acts on.
 *
 * **No credentials mode.** `omit`, explicitly: the board sets no cookies and
 * wants none, and a request that carried ambient credentials would be a request
 * that could be made on the user's behalf by something else.
 */
async function post(path: string, token: string | null, body: unknown): Promise<unknown | null> {
  if (!(await permitted())) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOARD_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers['authorization'] = `Bearer ${token}`;

    const response = await fetch(`${BOARD_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      credentials: 'omit',
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    // Offline, aborted, refused, or answering something that is not JSON.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the optional host permission has been granted.
 *
 * Checked rather than assumed on every call: Chrome lets the user revoke an
 * optional grant at any time from its own UI, and a revoked origin makes
 * `fetch` fail in a way that looks exactly like the network being down.
 */
async function permitted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [BOARD_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const held = (value as Record<string, unknown>)[key];
  return typeof held === 'string' && held !== '' ? held : null;
}

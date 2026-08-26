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
 * **The account email travels once, at enrolment.** The board keys a profile on
 * the Claude account, which is what makes one account one public profile across
 * every browser — but a daily submission carries only a bearer token, so the
 * address does not ride along on every request or accumulate in the host's
 * logs. Switching accounts re-enrols; see `adopt`.
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
import { providers } from './collector';
import {
  readAccountEmail,
  readAccountId,
  readHistory,
  readSettings,
  writeAccountEmail,
  writeSettings,
} from './store';

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

  // Publishing stops the moment the signed-in account stops being the one this
  // token belongs to. The board keys a profile on the account, so a day sent
  // now would attribute one account's work to another's public page — the same
  // mistake the snapshot merge refuses to make with `accountId`, and the reason
  // the answer here is silence rather than a best guess.
  //
  // It resumes by itself: the content script reports the new account, `adopt`
  // enrols for it, and the next tick publishes under the right profile.
  const signedInAs = await readAccountEmail();
  if (signedInAs !== null && settings.boardEmail !== null && signedInAs !== settings.boardEmail) {
    return;
  }

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

  if (message.type === 'wick:account-email') {
    // Fire and forget. The content script is reporting what it sees, not asking
    // for anything, and holding the reply channel open for a write it does not
    // read would be a port kept for nothing.
    void adopt(message.email).catch(() => undefined);
    return false;
  }

  return false;
}

/**
 * Note which Claude account is signed in, and re-enrol if it changed.
 *
 * The board keys a profile on the account, so switching accounts means
 * switching profiles. Re-enrolling is safe and cheap: the server returns the
 * *existing* name for an account it already knows, so coming back to an account
 * lands on the same public profile rather than creating a second one.
 *
 * `boardSubmittedThrough` is reset with the token, because the high-water mark
 * belongs to a profile rather than to the machine. Switching back and forth
 * therefore republishes days the board already has, which the upsert makes
 * harmless — it corrects a row rather than adding one.
 *
 * Does nothing at all when the user has not joined. Reading the address is free;
 * sending it is not, and an installation that never pressed Join never does.
 */
export async function adopt(email: string): Promise<void> {
  const normalised = email.trim().toLowerCase();
  if (normalised === '') return;

  const previous = await readAccountEmail();
  if (previous !== normalised) await writeAccountEmail(normalised);

  const settings = await readSettings();
  if (settings.boardToken === null) return;
  if (settings.boardEmail === normalised) return;

  // Enrolled, and the account underneath has changed. Drop the old binding
  // before asking for the new one: a failed enrolment must not leave the
  // previous account's token in place to publish this account's days.
  await writeSettings({ boardToken: null, boardName: null, boardSubmittedThrough: null });
  await enroll();
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
  // Already joined, for the account currently signed in. `adopt` clears the
  // binding first when the account changes, so reaching here with a token means
  // there is nothing to do.
  if (boardToken !== null) return 'ok';

  // The account is the profile's primary key, so there is nothing to enrol
  // without it — and `no-account` rather than `unavailable`, because nothing is
  // down and the user has a step to take.
  const email = await currentAccount();
  if (email === null) return 'no-account';

  const body = await post('/api/enroll', null, { email });
  if (body === null) return 'unavailable';

  const token = stringField(body, 'token');
  const name = stringField(body, 'name');
  if (token === null || name === null) return 'unavailable';

  await writeSettings({
    boardToken: token,
    boardName: name,
    boardEmail: email,
    boardSubmittedThrough: null,
  });
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

  await writeSettings({
    boardToken: null,
    boardName: null,
    boardEmail: null,
    boardSubmittedThrough: null,
  });
  return 'ok';
}

/**
 * Which Claude account is signed in.
 *
 * The stored answer when there is one, and otherwise **asked of an open
 * claude.ai tab there and then**. The second half matters more than it looks:
 * Join is pressed in the popup, the account is only readable from the page, and
 * the content script reports on a five-second poll — so a user who installs
 * Wick and opens the popup promptly would otherwise be told the leaderboard was
 * unreachable when the only problem was that nobody had looked yet.
 *
 * Asking costs one message to one tab, and only when the answer is not already
 * known. `chrome.tabs.query` with a URL filter needs no `tabs` permission of its
 * own — it reads URLs only for hosts Wick already has permission for, the same
 * way the poll cadence decides whether anyone is watching.
 *
 * The patterns come from the providers rather than being written here: no
 * claude.ai URL may appear outside `src/providers/`.
 */
async function currentAccount(): Promise<string | null> {
  const stored = await readAccountEmail();
  if (stored !== null) return stored;

  const patterns = providers.flatMap((provider) => provider.matchPatterns);
  if (patterns.length === 0) return null;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch {
    // A browser shutting down. Not knowing is a handled state.
    return null;
  }

  for (const tab of tabs) {
    if (tab.id === undefined) continue;

    // Inside the loop, deliberately. `sendMessage` **rejects** for a tab with no
    // listener — a page whose content script has not run yet, or one loaded
    // before the extension was updated — and catching outside would let the
    // first such tab abandon the search while a perfectly good tab sat behind
    // it.
    try {
      const reply = (await chrome.tabs.sendMessage(tab.id, {
        type: 'wick:read-account',
      })) as RuntimeResponse | undefined;

      if (reply === undefined || !reply.ok || !('email' in reply)) continue;
      if (reply.email === null) continue;

      // Remember it, so the next caller does not have to ask again and so a
      // later account switch has something to compare against.
      await writeAccountEmail(reply.email);
      return reply.email;
    } catch {
      // This tab cannot answer. The next one might.
      continue;
    }
  }

  return null;
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

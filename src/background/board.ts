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
import {
  isExtensionPageSender,
  isProviderContentSender,
  isRuntimeMessage,
  type BoardOutcome,
  type RuntimeResponse,
} from '~/core/messages';
import type { LeaderboardDailyEntry } from '~/core/types';
import { POLL_ALARM } from './alarms';
import { providers } from './collector';
import {
  leaderboardRetentionStart,
  normaliseAccountEmail,
  readAccountEmail,
  readLeaderboardLedger,
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

/**
 * Every board operation shares one queue. Drain requests coalesce while one is
 * queued or running. Requesting an identity command immediately invalidates an
 * older drain, but identity commands themselves still complete in queue order:
 * an enrolment followed by Leave must mint the credential that Leave needs.
 */
let operationTail: Promise<void> = Promise.resolve();
let operationRevision = 0;
let activeDrain: Promise<void> | null = null;

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const result = operationTail.then(work, work);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function identityOperation<T>(work: (revision: number) => Promise<T>): Promise<T> {
  const revision = ++operationRevision;
  return serialise(() => work(revision));
}

function isCurrent(revision: number): boolean {
  return revision === operationRevision;
}

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

  // Listener registration must finish before startup work can suspend. A poll
  // arriving during this drain then observes `activeDrain` and shares it.
  void drain().catch(() => undefined);
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
export function drain(now = Date.now()): Promise<void> {
  if (activeDrain !== null) return activeDrain;

  const revision = operationRevision;
  const running = serialise(async () => {
    await drainCore(now, revision);
  });
  activeDrain = running;
  void running
    .finally(() => {
      if (activeDrain === running) activeDrain = null;
    })
    .catch(() => undefined);
  return running;
}

type DrainOutcome = 'complete' | 'unauthorized' | 'stale';

async function drainCore(now: number, revision: number): Promise<DrainOutcome> {
  const settings = await readSettings();
  const token = settings.boardToken;
  if (token === null || !isCurrent(revision)) return isCurrent(revision) ? 'complete' : 'stale';

  // Check only whether a settled row exists before asking live tabs. This keeps
  // today's-only state as waiting even when identity is temporarily unknown.
  // A null binding checks all local ledger partitions for eligibility only; no
  // row is selected for submission until a live-normalized email is known.
  const boundEmail =
    settings.boardEmail === null ? null : normaliseAccountEmail(settings.boardEmail);
  const candidates = await pendingDays(boundEmail, settings.boardSubmittedThrough, now);
  if (!isCurrent(revision)) return 'stale';
  if (candidates.length === 0) {
    await writeSettings({
      boardSyncState:
        settings.boardSubmittedThrough === null
          ? { kind: 'waiting-for-day-close' }
          : { kind: 'accepted-through', day: settings.boardSubmittedThrough },
    });
    return 'complete';
  }

  // An open provider tab is authoritative. With no provider tabs, the last
  // observed account is retained so a sleeping browser can publish settled
  // local rows; a present tab that cannot confirm it always blocks.
  const observedEmail = await currentAccount();
  if (!isCurrent(revision)) return 'stale';
  if (
    observedEmail === null ||
    boundEmail === null ||
    observedEmail !== boundEmail
  ) {
    await writeSettings({ boardSyncState: { kind: 'retry-pending' } });
    return 'complete';
  }

  // Re-read by the freshly observed normalized email. The earlier candidates
  // were an eligibility check only and can never choose public data.
  const pending = await pendingDays(observedEmail, settings.boardSubmittedThrough, now);
  if (!isCurrent(revision)) return 'stale';
  if (pending.length === 0) {
    await writeSettings({
      boardSyncState:
        settings.boardSubmittedThrough === null
          ? { kind: 'waiting-for-day-close' }
          : { kind: 'accepted-through', day: settings.boardSubmittedThrough },
    });
    return 'complete';
  }

  await writeSettings({ boardSyncState: { kind: 'syncing' } });

  for (const day of pending) {
    if (!isCurrent(revision)) return 'stale';
    const outcome = await submit(token, day);
    if (!isCurrent(revision)) return 'stale';

    if (outcome === 'unauthorized') {
      // Only the operation that used this token may clear it. Leave, adoption,
      // or a fresh enrolment requested while the request was in flight owns the
      // credential now, even though it is still waiting in the serial queue.
      await clearEnrollment(revision);
      return 'unauthorized';
    }

    if (outcome !== 'accepted') {
      await writeSettings({ boardSyncState: { kind: 'retry-pending' } });
      return 'complete';
    }

    await writeSettings({
      boardSubmittedThrough: day.date,
      boardSyncState: { kind: 'accepted-through', day: day.date },
    });
  }

  return 'complete';
}

/**
 * The settled days after the high-water mark, oldest first.
 *
 * Today is excluded because it is still accumulating. Days before the mark are
 * excluded because they are already published — and a day the user has *since*
 * accrued more messages on cannot be corrected, which is the price of a single
 * date as the bookmark and is worth it for how little it can go wrong.
 *
 * Exported for tests: which days are eligible is pinned independently from
 * transport, and a non-null email always selects only its local ledger rows.
 */
export async function pendingDays(
  email: string | null,
  submittedThrough: string | null,
  now: number,
): Promise<LeaderboardDailyEntry[]> {
  const ledger = await readLeaderboardLedger(email);
  const today = localDateKey(now);
  const retainedFrom = leaderboardRetentionStart(now);

  return ledger
    // Defend the transport against rows written before calendar retention was
    // enforced. An age-rejected oldest row must not wedge every newer row.
    .filter((day) => day.date >= retainedFrom)
    .filter((day) => typeof day.date === 'string')
    .filter((day) => day.date < today)
    .filter((day) => submittedThrough === null || day.date > submittedThrough)
    .filter((day) => Number.isSafeInteger(day.messages) && day.messages >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, MAX_DRAIN_DAYS);
}

/**
 * Publish one day. `true` when the board took it.
 *
 * The body carries the date and the count, and that is the whole of it. There
 * is deliberately no email, window key, utilization, organisation id or hourly
 * breakdown. The local ledger partition key is stripped here; what is not sent
 * cannot leak.
 */
type SubmitOutcome = 'accepted' | 'unauthorized' | 'retryable';

async function submit(token: string, day: LeaderboardDailyEntry): Promise<SubmitOutcome> {
  const result = await post('/api/submit', token, {
    day: day.date,
    messages: day.messages,
  });

  if (result.kind === 'accepted') return 'accepted';
  if (result.kind === 'unauthorized') return 'unauthorized';
  return 'retryable';
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
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void,
): boolean {
  if (!isRuntimeMessage(message)) return false;

  if (message.type === 'wick:board-enroll') {
    if (!isExtensionPageSender(sender)) return false;
    void enroll()
      .then((outcome) => sendResponse({ ok: true, outcome }))
      .catch(() => sendResponse({ ok: true, outcome: 'unavailable' }));
    return true;
  }

  if (message.type === 'wick:board-leave') {
    if (!isExtensionPageSender(sender)) return false;
    void leave()
      .then((outcome) => sendResponse({ ok: true, outcome }))
      .catch(() => sendResponse({ ok: true, outcome: 'unavailable' }));
    return true;
  }

  if (message.type === 'wick:account-email') {
    if (
      !isProviderContentSender(
        sender,
        providers.flatMap((provider) => provider.matchPatterns),
      )
    ) {
      return false;
    }
    // Serialized with enrol/leave/drain even though the reporter does not wait
    // for a response. Null pauses publication but never destroys its token.
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
export function adopt(email: string | null): Promise<void> {
  return identityOperation((revision) => adoptCore(email, revision));
}

async function adoptCore(email: string | null, revision: number): Promise<void> {
  if (email === null) {
    // Unknown is durable so a stale cache cannot publish, but the credential is
    // retained: Leave must still be able to delete the old public profile.
    await writeAccountEmail(null);
    return;
  }

  const normalised = normaliseAccountEmail(email);
  if (normalised === null) return;

  const previous = await readAccountEmail();
  if (previous !== normalised) await writeAccountEmail(normalised);

  const settings = await readSettings();
  if (settings.boardToken === null) return;
  if (settings.boardEmail === normalised) return;

  // Enrolled, and the account underneath has changed. Drop the old binding
  // before asking for the new one: a failed enrolment must not leave the
  // previous account's token in place to publish this account's days.
  await writeSettings({
    boardToken: null,
    boardName: null,
    boardEmail: null,
    boardSubmittedThrough: null,
    boardSyncState: { kind: 'waiting-for-day-close' },
  });
  await enrollCore(revision);
}

/**
 * Ask the board for a participant token and a name.
 *
 * Nothing identifying is sent, because there is nothing to send: the board
 * mints the token and assigns the name, and the extension's only contribution
 * to its own identity is holding the token afterwards. That is the whole
 * anonymity argument, and it rests on this request having an empty body.
 *
 * Enrolling immediately offers any already completed rows. Today's row remains
 * local until the date changes, exactly as it does on every later drain.
 */
function enroll(): Promise<BoardOutcome> {
  return identityOperation(enrollCore);
}

async function enrollCore(revision: number): Promise<BoardOutcome> {
  const { boardToken } = await readSettings();
  // Already joined, for the account currently signed in. `adopt` clears the
  // binding first when the account changes, so reaching here with a token means
  // there is nothing to do.
  if (boardToken !== null) return 'ok';

  const email = await currentAccount();
  if (email === null) return 'no-account';

  const result = await post('/api/enroll', null, { email });
  if (result.kind !== 'accepted') return 'unavailable';

  const token = stringField(result.body, 'token');
  const name = stringField(result.body, 'name');
  if (token === null || name === null) return 'unavailable';

  // Identity commands are ordered, not cancelled. A Leave requested while this
  // request was in flight needs the accepted token in order to delete the
  // server profile. The revision applies only to the opportunistic drain below.
  await writeSettings({
    boardToken: token,
    boardName: name,
    boardEmail: email,
    boardSubmittedThrough: null,
    boardSyncState: { kind: 'waiting-for-day-close' },
  });

  const drained = await drainCore(Date.now(), revision);
  return drained === 'unauthorized' ? 'unavailable' : 'ok';
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
function leave(): Promise<BoardOutcome> {
  return identityOperation(leaveCore);
}

async function leaveCore(_revision: number): Promise<BoardOutcome> {
  const { boardToken } = await readSettings();
  if (boardToken === null) return 'ok';

  const result = await post('/api/leave', boardToken, {});
  if (result.kind !== 'accepted') return 'unavailable';

  await clearEnrollment();
  return 'ok';
}

async function clearEnrollment(revision?: number): Promise<void> {
  // Drains are speculative background work and may only clear the binding they
  // started with. Serialized identity commands omit the revision because their
  // accepted transitions must complete before the next queued command starts.
  if (revision === undefined) {
    await writeSettings(CLEARED_ENROLLMENT);
    return;
  }

  if (!isCurrent(revision)) return;
  const captured = await readSettings();
  if (!isCurrent(revision)) return;

  await writeSettings(CLEARED_ENROLLMENT);
  if (isCurrent(revision)) return;

  // An identity intent may arrive while chrome.storage.local.set is suspended.
  // It cannot run until this serialized drain returns, so restore the binding
  // it needs before yielding the queue. The stale submit remains pending rather
  // than pretending the cleared write won the race.
  await writeSettings({
    boardToken: captured.boardToken,
    boardName: captured.boardName,
    boardEmail: captured.boardEmail,
    boardSubmittedThrough: captured.boardSubmittedThrough,
    boardSyncState: { kind: 'retry-pending' },
  });
}

const CLEARED_ENROLLMENT = {
  boardToken: null,
  boardName: null,
  boardEmail: null,
  boardSubmittedThrough: null,
  boardSyncState: { kind: 'waiting-for-day-close' },
} as const;

/**
 * Which Claude account is signed in.
 *
 * Open claude.ai tabs are asked every time identity authorises a board action.
 * Their live answer is authoritative over storage: if present tabs cannot agree
 * on one non-null account, publication and enrolment stop. Only when no provider
 * tab is open may the last content-script observation be used. This permits a
 * sleeping browser to drain settled local rows without allowing a stale cache
 * to override a page that is signed out or showing another account.
 *
 * `chrome.tabs.query` with a URL filter needs no `tabs` permission of its own —
 * it reads URLs only for hosts Wick already has permission for. The patterns
 * come from providers rather than being written here: no claude.ai URL may
 * appear outside `src/providers/`.
 */
async function currentAccount(): Promise<string | null> {
  const stored = await readAccountEmail();
  const patterns = providers.flatMap((provider) => provider.matchPatterns);
  if (patterns.length === 0) return null;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch {
    // Query failure cannot prove there are no provider tabs, so it fails closed.
    return null;
  }

  // With no live provider page there is nothing newer to consult. Keeping the
  // last content-script observation lets settled rows drain after tabs close.
  if (tabs.length === 0) return stored;

  let observed: string | null = null;
  for (const tab of tabs) {
    // Every tab returned by the provider-host query is evidence that a live
    // account may differ from the cache. If it cannot be queried, no other tab
    // may stand in for it.
    if (tab.id === undefined) return null;

    let reply: RuntimeResponse | undefined;
    try {
      reply = (await chrome.tabs.sendMessage(tab.id, {
        type: 'wick:read-account',
      })) as RuntimeResponse | undefined;
    } catch {
      return null;
    }

    if (
      reply === undefined ||
      !reply.ok ||
      !('email' in reply) ||
      (typeof reply.email !== 'string' && reply.email !== null)
    ) {
      return null;
    }

    if (reply.email === null) {
      await writeAccountEmail(null);
      return null;
    }

    const normalised = normaliseAccountEmail(reply.email);
    if (normalised === null) {
      await writeAccountEmail(null);
      return null;
    }
    if (observed !== null && observed !== normalised) {
      await writeAccountEmail(null);
      return null;
    }
    observed = normalised;
  }

  if (observed === null) return null;
  if (stored !== observed) await writeAccountEmail(observed);
  return observed;
}

/* ---- Transport ----------------------------------------------------------- */

/** A transport result safe to act on and persist without retaining server detail. */
type TransportOutcome =
  | { kind: 'accepted'; body: unknown }
  | { kind: 'unauthorized' }
  | { kind: 'retryable' }
  | { kind: 'rejected' };

/**
 * POST JSON to the board without throwing.
 *
 * Callers need to distinguish a dead bearer token from a temporary outage, but
 * no response body, status text, or server detail is persisted. Other 4xx
 * responses are refused rather than guessed retryable; publication still stops
 * before advancing its high-water mark.
 *
 * **No credentials mode.** `omit`, explicitly: the board sets no cookies and
 * wants none, and a request that carried ambient credentials would be a request
 * that could be made on the user's behalf by something else.
 */
async function post(
  path: string,
  token: string | null,
  body: unknown,
): Promise<TransportOutcome> {
  if (!(await permitted())) return { kind: 'retryable' };

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

    if (response.ok) {
      return { kind: 'accepted', body: (await response.json()) as unknown };
    }
    if (response.status === 401) return { kind: 'unauthorized' };
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return { kind: 'retryable' };
    }
    return { kind: 'rejected' };
  } catch {
    // Offline, aborted, refused, or an accepted response that was not JSON.
    return { kind: 'retryable' };
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

/**
 * The only module that performs network I/O or reads cookies.
 *
 * It owns the providers, turns readings into normalised snapshots, and writes
 * them to the store. It knows about claude.ai only through `src/providers/`;
 * it knows nothing about Wick's interface.
 *
 * The one rule the rest of the background depends on: **`poll` never rejects.**
 * Every reading it takes is of an undocumented endpoint that may have changed
 * shape this morning, and an unhandled rejection in a service worker is not a
 * logged warning — it is the worker going away and no further polls happening.
 * Failure is written to the store as a status the interface can show.
 */

import { isRuntimeMessage, type RuntimeMessage, type RuntimeResponse } from '~/core/messages';
import type { LimitWindow, Snapshot, SnapshotSource } from '~/core/types';
import { claudeProvider } from '~/providers/claude';
import type { UsageProvider, UsageResult } from '~/providers/types';
import { initAlarms, syncPollCadence } from './alarms';
import {
  clearSnapshot,
  readAccountId,
  readState,
  recordMessage,
  recordReading,
  writeAccountId,
  writeSnapshot,
  writeStatus,
} from './store';

/** Providers Wick collects from. One, for now — see the decision records. */
export const providers: UsageProvider[] = [claudeProvider];

/** Why a poll is happening. Only `invalidation` is rate-limited. */
export type PollReason = 'alarm' | 'refresh' | 'invalidation' | 'install' | 'reconcile' | 'tab';

/**
 * Shortest gap between two polls triggered by an observed account change.
 *
 * One plan change fires several of the watched requests, and a page load fires
 * some of them again. Without this, opening claude.ai would cost three
 * back-to-back fetches for one piece of news.
 */
const INVALIDATION_GAP_MS = 5_000;

/**
 * How long to wait after a completion before asking the endpoint about it.
 *
 * A `message_limit` event is the server's own number, but it is the number as
 * of the moment the stream started; claude.ai's accounting settles a beat
 * later. Polling immediately reads the pre-send figure and looks like the send
 * did not count. This delay is a placeholder until it is measured against live
 * traffic — see the protocol-verification notes, step 8, which exists to replace
 * this constant with an observation.
 */
export const RECONCILE_DELAY_MS = 4_000;

/** Module-level, so it is forgotten on worker teardown. Losing it costs one poll. */
let lastPollAt = 0;

/**
 * The poll currently running, if any.
 *
 * Every trigger — the alarm, the popup opening, a plan change, a completion
 * settling — can fire while another poll is still awaiting a response. Without
 * this they stack: several requests for one answer, and several writes racing
 * to record it. Callers all await the same poll instead.
 */
let inFlight: Promise<void> | null = null;

/** A reconcile already scheduled. One pending refresh is enough for any burst. */
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Forget everything the collector only holds in memory.
 *
 * In the browser this happens by itself: MV3 tears the worker down when idle
 * and every one of these is rebuilt on the next event. Tests share one module
 * instance across cases, so they need to ask.
 */
export function resetCollectorMemory(): void {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  inFlight = null;
  lastPollAt = 0;
  counted.clear();
}

/** Register every listener the collector needs. Called once, synchronously. */
export function initCollector(): void {
  initAlarms(
    () => poll('alarm'),
    providers.flatMap((provider) => provider.matchPatterns),
  );

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  watchInvalidations();

  // A worker that has just started knows nothing, and the first alarm is a
  // whole cadence away. Both of these fire before any user action.
  chrome.runtime.onInstalled.addListener(() => void poll('install'));
  chrome.runtime.onStartup?.addListener(() => void poll('install'));
}

/**
 * Poll every provider now and write what comes back.
 *
 * Resolves whatever happens. A provider that throws, a shape that changed, a
 * network that is not there — each becomes an `error` status and the loop
 * carries on to the next provider.
 *
 * Concurrent calls share one poll: the second caller awaits the first rather
 * than starting a second round of requests.
 */
export async function poll(reason: PollReason): Promise<void> {
  if (inFlight !== null) return inFlight;

  const now = Date.now();
  if (reason === 'invalidation' && now - lastPollAt < INVALIDATION_GAP_MS) return;
  lastPollAt = now;

  inFlight = (async () => {
    for (const provider of providers) {
      await pollProvider(provider);
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Ask the authoritative endpoint about a send that just happened.
 *
 * One timer, however many events arrive: a completion that produces a
 * `message_limit` event and then a refusal is one send, and it deserves one
 * fetch. The timer is deliberately short — the worker stays alive for a few
 * seconds after handling a message, and if it is torn down anyway the poll
 * alarm is at most a minute behind, because a tab is open by definition when a
 * completion just happened.
 */
export function scheduleReconcile(delay = RECONCILE_DELAY_MS): void {
  if (reconcileTimer !== null) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void poll('reconcile');
  }, delay);
}

async function pollProvider(provider: UsageProvider): Promise<void> {
  try {
    const accountId = await provider.resolveAccountId();
    if (accountId === null) {
      // No cookie. Not an error — but the numbers on screen belong to a session
      // that is over, and leaving them there is a lie the user cannot see.
      await signedOut();
      return;
    }

    await writeAccountId(accountId);
    const result = await usageResult(provider, accountId);

    if (result.kind === 'signed-out') {
      await signedOut();
      return;
    }

    if (result.kind === 'unavailable') {
      await writeStatus({ kind: 'error', message: result.message, at: Date.now() });
      return;
    }

    const at = Date.now();
    const stored = await writeSnapshot(
      { providerId: provider.id, accountId, windows: result.windows, source: 'usage', at },
      at,
    );
    await recordAccepted(stored, at, accountId);
    await writeStatus({ kind: 'ok', at });
  } catch (error) {
    await writeStatus({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    }).catch(() => undefined);
  }
}

/**
 * Prefer the detailed fetch, fall back to the plain one.
 *
 * A provider that only implements `fetchUsage` cannot say why it came back
 * empty, so an empty result from it is reported as ok-with-nothing rather than
 * guessed at.
 */
async function usageResult(provider: UsageProvider, accountId: string): Promise<UsageResult> {
  if (provider.fetchUsageResult) return provider.fetchUsageResult(accountId);
  return { kind: 'ok', windows: await provider.fetchUsage(accountId), path: '' };
}

/**
 * Sign-out: say so, and stop showing the departed session's numbers.
 *
 * The snapshot goes because it describes a session that no longer exists. The
 * account tag stays, and deliberately: it is the answer to "whose record is
 * this", and signing out of claude.ai does not change whose record it is.
 * Clearing it would make the panel's own history vanish along with the numbers,
 * which is a much bigger claim than "you are signed out". The next poll after a
 * different account signs in overwrites it.
 *
 * History survives for the same reason — it is the user's own record, and it is
 * append-only.
 */
async function signedOut(): Promise<void> {
  await writeStatus({ kind: 'signed-out' });
  await clearSnapshot();
}

/**
 * Fold the numbers Wick actually accepted into today's rollup.
 *
 * Driven from the merged snapshot rather than from the reading, because the
 * merge is where precedence is decided: a window the store refused as stale
 * must not be folded into the peak, or an out-of-order reading outlives the
 * snapshot it was rejected from. Windows without a number are simply absent —
 * a missing percentage is not a zero.
 */
async function recordAccepted(
  stored: Snapshot | null,
  at: number,
  accountId: string | null,
): Promise<void> {
  if (stored === null) return;

  const utilizations: Record<string, number> = {};
  for (const window of stored.windows) {
    if (window.observedAt !== at) continue;
    if (window.utilization !== null) utilizations[window.key] = window.utilization;
  }

  if (Object.keys(utilizations).length === 0) return;
  await recordReading(utilizations, at, accountId);
}

/* ---- Messages ------------------------------------------------------------ */

/**
 * The message types this module answers.
 *
 * Named rather than inferred from `isRuntimeMessage`, because the relay
 * messages travel the same channel and belong to `alerts.ts`. Claiming one of
 * those by returning `true` would hold the reply port open for an answer this
 * module is never going to send, and the caller would see `undefined` instead
 * of the answer the other listener produced.
 */
const HANDLED = [
  'wick:stream-limits',
  'wick:message-sent',
  'wick:refresh',
  'wick:tab-open',
  'wick:get-state',
] as const;

type CollectorMessage = Extract<RuntimeMessage, { type: (typeof HANDLED)[number] }>;

function isCollectorMessage(message: RuntimeMessage): message is CollectorMessage {
  return (HANDLED as readonly string[]).includes(message.type);
}

/**
 * Handle one message from the content bridge or the popup.
 *
 * Exported for tests, which drive it directly rather than through the mock's
 * message bus — the reply is asynchronous, and asserting on it is the point.
 *
 * Returns `true` for anything it owns, which is what keeps the reply channel
 * open across the `await`. Returning nothing there makes Chrome close the port
 * and the caller sees `undefined` for a reply that was on its way.
 */
export function handleRuntimeMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void,
): boolean {
  if (!isRuntimeMessage(message) || !isCollectorMessage(message)) return false;

  void respond(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
}

async function respond(message: CollectorMessage): Promise<RuntimeResponse> {
  switch (message.type) {
    case 'wick:stream-limits':
      await acceptStreamLimits(message.windows, message.at, message.source);
      return { ok: true };

    case 'wick:message-sent':
      await countMessage(message.id, message.at);
      return { ok: true };

    case 'wick:refresh':
      await poll('refresh');
      return { ok: true };

    case 'wick:tab-open':
      // Cadence first: the poll that follows is one reading, and the cadence is
      // every reading after it.
      await syncPollCadence();
      await poll('tab');
      return { ok: true };

    case 'wick:get-state':
      return { ok: true, state: await readState() };
  }
}

/**
 * How many recently counted completions to remember.
 *
 * De-duplication only has to survive the moment: the ids it guards against are
 * two observations of one in-flight request, seconds apart at most. A few dozen
 * is far more than any burst, and the set dies with the worker, which is
 * exactly the lifetime the problem has.
 */
const COUNTED_LIMIT = 64;

const counted = new Set<string>();

/** Count one accepted completion, unless this exact request was already counted. */
async function countMessage(id: string, at: number): Promise<void> {
  if (counted.has(id)) return;

  counted.add(id);
  if (counted.size > COUNTED_LIMIT) {
    const oldest = counted.values().next().value;
    if (oldest !== undefined) counted.delete(oldest);
  }

  await recordMessage(at, await readAccountId());
}

/**
 * Write an optimistic reading seen on the wire.
 *
 * Two things happen, in this order and for different reasons: the reading goes
 * in immediately, because it is what the user just did and they should see it
 * now; and an authoritative fetch is scheduled, because the reading is the
 * server's number from a beat earlier and only the endpoint can confirm where
 * the account actually landed.
 *
 * Precedence lives in the store, so this only has to respect its answer.
 */
async function acceptStreamLimits(
  windows: LimitWindow[],
  at: number,
  source: SnapshotSource,
): Promise<void> {
  const accountId = await readAccountId();

  const stored = await writeSnapshot(
    {
      // The message carries no provider tag because only one provider has a
      // MAIN-world bridge. A second one means a field here, not a guess.
      providerId: claudeProvider.id,
      accountId,
      windows,
      source,
      at,
    },
    at,
  );

  await recordAccepted(stored, at, accountId);
  scheduleReconcile();
}

/* ---- Cache invalidation -------------------------------------------------- */

/**
 * Poll when an account or billing change lands.
 *
 * Headers only — no `extraInfoSpec`, no body read, and MV3 could not read one
 * anyway. All this listener learns is that a URL completed, which is all it
 * needs: the plan may have changed, so the cached numbers may be about a limit
 * that no longer exists.
 */
function watchInvalidations(): void {
  const urls = providers.flatMap((provider) => provider.invalidationPatterns ?? []);
  if (urls.length === 0) return;

  chrome.webRequest.onCompleted.addListener(() => {
    void poll('invalidation');
  }, { urls });
}

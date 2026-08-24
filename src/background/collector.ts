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
import type { LimitWindow } from '~/core/types';
import { claudeProvider } from '~/providers/claude';
import type { UsageProvider, UsageResult } from '~/providers/types';
import { initAlarms } from './alarms';
import { readState, recordMessage, recordReading, writeSnapshot, writeStatus } from './store';

/** Providers Wick collects from. One, for now — see docs/decisions/. */
export const providers: UsageProvider[] = [claudeProvider];

/** Why a poll is happening. Only `invalidation` is rate-limited. */
export type PollReason = 'alarm' | 'refresh' | 'invalidation' | 'install';

/**
 * Shortest gap between two polls triggered by an observed account change.
 *
 * One plan change fires several of the watched requests, and a page load fires
 * some of them again. Without this, opening claude.ai would cost three
 * back-to-back fetches for one piece of news.
 */
const INVALIDATION_GAP_MS = 5_000;

/** Module-level, so it is forgotten on worker teardown. Losing it costs one poll. */
let lastPollAt = 0;

/** Register every listener the collector needs. Called once, synchronously. */
export function initCollector(): void {
  initAlarms(
    () => poll('alarm'),
    providers.flatMap((provider) => provider.matchPatterns),
  );

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  watchInvalidations();
}

/**
 * Poll every provider now and write what comes back.
 *
 * Resolves whatever happens. A provider that throws, a shape that changed, a
 * network that is not there — each becomes an `error` status and the loop
 * carries on to the next provider.
 */
export async function poll(reason: PollReason): Promise<void> {
  const now = Date.now();
  if (reason === 'invalidation' && now - lastPollAt < INVALIDATION_GAP_MS) return;
  lastPollAt = now;

  for (const provider of providers) {
    await pollProvider(provider);
  }
}

async function pollProvider(provider: UsageProvider): Promise<void> {
  try {
    const accountId = await provider.resolveAccountId();
    if (accountId === null) {
      // No cookie. Not an error, and not something to show a stale number for.
      await writeStatus({ kind: 'signed-out' });
      return;
    }

    const result = await usageResult(provider, accountId);

    if (result.kind === 'signed-out') {
      await writeStatus({ kind: 'signed-out' });
      return;
    }

    if (result.kind === 'unavailable') {
      await writeStatus({ kind: 'error', message: result.message, at: Date.now() });
      return;
    }

    const at = Date.now();
    await writeSnapshot({
      providerId: provider.id,
      windows: result.windows,
      fetchedAt: at,
      source: 'usage',
    });
    await recordUtilizations(result.windows, at);
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

/** Fold the numbers into today's rollup. Windows without one are simply absent. */
async function recordUtilizations(windows: LimitWindow[], at: number): Promise<void> {
  const utilizations: Record<string, number> = {};
  for (const window of windows) {
    if (window.utilization !== null) utilizations[window.key] = window.utilization;
  }
  if (Object.keys(utilizations).length === 0) return;
  await recordReading(utilizations, at);
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
      await acceptStreamLimits(message.windows, message.at);
      return { ok: true };

    case 'wick:message-sent':
      await recordMessage(message.at);
      return { ok: true };

    case 'wick:refresh':
      await poll('refresh');
      return { ok: true };

    case 'wick:get-state':
      return { ok: true, state: await readState() };
  }
}

/**
 * Write an optimistic reading from the stream.
 *
 * Precedence lives in the store, so this only has to respect its answer: when
 * the write is refused, an authoritative fetch already covered this moment and
 * the rollup must not be touched either. Folding a lower-trust number into the
 * peak after a fetch has spoken would let the optimistic reading outlive the
 * snapshot it was refused from.
 */
async function acceptStreamLimits(windows: LimitWindow[], at: number): Promise<void> {
  const written = await writeSnapshot({
    // The message carries no provider tag because only one provider has a
    // MAIN-world bridge. A second one means a field here, not a guess.
    providerId: claudeProvider.id,
    windows,
    fetchedAt: at,
    source: 'stream',
  });

  if (!written) return;
  await recordUtilizations(windows, at);
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

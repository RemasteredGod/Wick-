/**
 * Poll scheduling.
 *
 * Wick polls on a `chrome.alarms` schedule rather than a timer, because an MV3
 * service worker is torn down between events and a `setInterval` dies with it.
 *
 * The cadence follows attention: while a provider tab is open the user is
 * plausibly spending limit right now and a stale number is visible on their own
 * screen, so Wick checks every minute. With no tab open the number is not being
 * looked at, but limits still tick down in another browser or on a phone — so
 * checking continues, just rarely enough not to be rude about it.
 */

/** Poll interval while a provider tab is open, in minutes. */
export const ACTIVE_INTERVAL_MINUTES = 1;

/**
 * Poll interval with no provider tab open.
 *
 * Limits still tick down in another browser or on a phone, so Wick keeps
 * checking — just rarely enough not to be rude about it.
 */
export const IDLE_INTERVAL_MINUTES = 15;

export const POLL_ALARM = 'wick:poll';

/**
 * Tab patterns that mean "a provider is open".
 *
 * Passed in rather than written here: no claude.ai URL may appear outside
 * `src/providers/`. An empty list means Wick cannot tell, and it stays on the
 * idle cadence rather than assuming attention it has no evidence for.
 */
let watchedPatterns: string[] = [];

/**
 * The cadence the alarm is currently armed at.
 *
 * Module-level, so it is forgotten when the worker is torn down. The alarm
 * itself survives; the memo only exists to stop `syncPollCadence` from
 * re-creating an alarm at the cadence it already has, which would restart its
 * period and could starve polling if it happened often.
 */
let armedMinutes: number | null = null;

/**
 * Register the poll schedule. Call once, synchronously, at worker startup.
 *
 * `onPoll` is invoked on every alarm and is expected never to reject; its
 * rejection is swallowed here anyway, because an unhandled rejection in an
 * alarm handler takes the worker down with it.
 */
export function initAlarms(onPoll: () => Promise<void>, matchPatterns: string[] = []): void {
  watchedPatterns = matchPatterns;
  // A fresh registration re-arms unconditionally. The memo describes an alarm
  // this worker created; at startup there may be no alarm at all, and trusting
  // a stale memo would leave Wick registered for a poll that never comes.
  armedMinutes = null;

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    void onPoll().catch(() => undefined);
    // Re-checked on every fire rather than on tab events: tab lifecycle needs
    // no permission to query but does need one to subscribe to, and a cadence
    // that is one poll out of date costs nothing.
    void syncPollCadence();
  });

  // Both re-arm rather than assume: an alarm survives worker teardown but not
  // an update or a browser restart, and a Wick that silently stopped polling
  // after an update would be indistinguishable from a Wick that works.
  chrome.runtime.onInstalled.addListener(() => void syncPollCadence());
  chrome.runtime.onStartup?.addListener(() => void syncPollCadence());

  void syncPollCadence();
}

/**
 * Match the alarm cadence to whether a provider tab is open.
 *
 * Returns the interval now in force, so a caller — or a test — can see what was
 * decided without reading back the alarm.
 */
export async function syncPollCadence(): Promise<number> {
  const minutes = (await providerTabOpen()) ? ACTIVE_INTERVAL_MINUTES : IDLE_INTERVAL_MINUTES;
  if (minutes !== armedMinutes) armPollAlarm(minutes);
  return minutes;
}

/** Arm (or re-arm) the poll alarm. Idempotent from the caller's point of view. */
export function armPollAlarm(minutes: number): void {
  armedMinutes = minutes;
  chrome.alarms.create(POLL_ALARM, {
    // Chrome clamps periods below a minute in a packed extension; both
    // cadences sit at or above it, so neither is quietly rewritten.
    periodInMinutes: minutes,
    delayInMinutes: minutes,
  });
}

/**
 * Whether any tab is showing a provider.
 *
 * `chrome.tabs.query` with a URL filter reads URLs only for tabs matching a
 * host Wick already has permission for, so this needs no `tabs` permission of
 * its own. Anything thrown — a query on a shutting-down browser will — is read
 * as "no tab", which is the conservative answer.
 */
async function providerTabOpen(): Promise<boolean> {
  if (watchedPatterns.length === 0) return false;
  try {
    const tabs = await chrome.tabs.query({ url: watchedPatterns });
    return tabs.length > 0;
  } catch {
    return false;
  }
}

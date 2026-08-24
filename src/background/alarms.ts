/**
 * Poll scheduling.
 *
 * Wick polls on a `chrome.alarms` schedule rather than a timer, because an MV3
 * service worker is torn down between events and a `setInterval` dies with it.
 *
 * Status: M3.
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

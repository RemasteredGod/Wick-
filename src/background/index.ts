/**
 * Service worker entry point.
 *
 * Listeners are registered synchronously at the top level. An MV3 worker is
 * woken by an event and torn down again when idle, so a listener attached
 * inside a promise callback may simply not exist by the time the event it wants
 * arrives.
 *
 * Status: M1 scaffold. The handlers below establish the wake-up points; the
 * collection they will drive is M3.
 */

import { POLL_ALARM, ACTIVE_INTERVAL_MINUTES } from './alarms';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: ACTIVE_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  // M3: poll the provider, normalise, write the snapshot and the daily rollup.
});

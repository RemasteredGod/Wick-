/**
 * Answering commands, with no server.
 *
 * There is nowhere for Telegram to push an update to — ADR 0009 removed the
 * relay, and a browser extension has no public URL. So Wick pulls instead, on
 * the polling alarm it already runs for claude.ai. One `getUpdates` call per
 * tick, answer whatever is waiting, remember the offset, go back to sleep.
 *
 * **This is the only place Wick receives anything.** Alerts still travel one
 * way, and a user who never sends the bot a command never causes a call here
 * beyond the empty poll.
 *
 * Two consequences the help text is honest about: replies are not instant —
 * they arrive on the next tick, which is a minute with a claude.ai tab open and
 * fifteen without — and they do not arrive at all while Chrome is closed.
 */

import { POLL_ALARM } from './alarms';
import { parseCommand, reply, type Readings } from './commands';
import { getUpdates, send, type TelegramUpdate } from './telegram';
import { readHistory, readInboxOffset, readSettings, readSnapshot, writeInboxOffset } from './store';

/**
 * Register the inbox. Call once, synchronously, at worker startup.
 *
 * Its own alarm listener rather than a hook into the collector's: the two do
 * not need to know about each other, and a failure in one must not take the
 * other's poll down.
 */
export function initInbox(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    void drainInbox().catch(() => {
      // An unhandled rejection in an alarm handler takes the worker with it.
      // Nothing here is worth that: the next tick tries again.
    });
  });
}

/**
 * One pass: read what is waiting, answer it, and record the offset.
 *
 * Exported for tests, which drive it directly rather than firing an alarm.
 */
export async function drainInbox(): Promise<void> {
  const { botToken, chatId } = await readSettings();
  if (botToken === null || chatId === null) return;

  const offset = await readInboxOffset();
  const result = await getUpdates(botToken, offset);
  if (!result.ok) return;

  const updates = result.value;
  if (updates.length === 0) return;

  // Recorded before any reply is sent. A worker torn down mid-drain would
  // otherwise answer the same command again on the next tick, and a bot that
  // repeats itself is worse than one that misses a message.
  await writeInboxOffset(nextOffset(updates, offset));

  const readings = await currentReadings();

  for (const update of updates) {
    const message = update.message;
    if (message === undefined) continue;

    // **Only ever answer the connected chat.** A bot's username is public and
    // anyone who finds it can message it. Replying to whoever wrote would hand
    // a stranger this user's usage figures, which is the one failure in this
    // file that would actually matter.
    if (message.chat?.id !== chatId) continue;

    const text = typeof message.text === 'string' ? message.text : '';
    await send(reply(parseCommand(text), readings));
  }
}

/**
 * The offset to ask for next.
 *
 * Telegram redelivers every update until it is acknowledged, and asking for a
 * higher offset *is* the acknowledgement. Without this the bot replays its
 * whole backlog on every tick, forever.
 *
 * The highest id wins rather than the last, because order is not promised.
 */
export function nextOffset(updates: readonly TelegramUpdate[], current: number): number {
  let highest = current - 1;
  for (const update of updates) {
    if (update.update_id > highest) highest = update.update_id;
  }
  return highest + 1;
}

/** One read of everything the replies are built from. */
async function currentReadings(): Promise<Readings> {
  const [snapshot, history] = await Promise.all([readSnapshot(), readHistory()]);
  return { snapshot, history, now: Date.now() };
}

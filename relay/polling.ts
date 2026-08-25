/**
 * Long polling — the other way to receive updates.
 *
 * Telegram offers exactly two delivery mechanisms, and which one you can use is
 * decided by where the bot runs rather than by preference:
 *
 * - **`getUpdates`** (here). Your process asks Telegram for anything new and
 *   Telegram holds the request open until there is something or the timeout
 *   expires. Needs no public URL, no TLS certificate, no domain, and no
 *   registration. Works from a laptop behind NAT.
 * - **`setWebhook`** (telegram.ts). Telegram POSTs to a public HTTPS URL you
 *   own. Needed in production because a serverless function cannot sit in a
 *   loop waiting.
 *
 * **They are mutually exclusive.** While a webhook is registered, `getUpdates`
 * returns 409 and polling cannot start; that is the single most common way to
 * lose an afternoon to this API, so `pollOnce` reports it as its own failure
 * with the fix rather than as a generic error.
 *
 * Only one consumer may poll a bot at a time. Two processes polling the same
 * token will steal updates from each other at random.
 */

import { handle, parseCommand, type Context } from './commands';
import { sendMessage, type TelegramConfig } from './telegram';

/**
 * How long Telegram holds an empty request open, in seconds.
 *
 * Long polling, not busy polling: a 30-second hold means one request every
 * thirty seconds when nothing is happening, rather than hammering the API. The
 * request returns the instant an update arrives, so this costs no latency.
 */
export const POLL_TIMEOUT_S = 30;

/** One update, as much of it as this module reads. */
export interface PolledUpdate {
  update_id: number;
  message?: { text?: unknown; chat?: { id?: unknown } };
}

export type PollFailure =
  /** A webhook is registered. Delete it before polling — see `deleteWebhook`. */
  | 'webhook-conflict'
  /** Unauthorised: the bot token is wrong. */
  | 'bad-token'
  /** Network, timeout, or an unreadable body. */
  | 'failed';

export type PollResult =
  | { ok: true; updates: PolledUpdate[] }
  | { ok: false; failure: PollFailure };

/**
 * The offset to ask for next.
 *
 * Telegram redelivers every update until it is acknowledged, and the
 * acknowledgement *is* asking for a higher offset. Forget this and the bot
 * replays its entire backlog on every request, forever — answering `/forget`
 * once a second until the process is killed.
 *
 * Pure, and the highest id wins rather than the last one, because order is not
 * promised.
 */
export function nextOffset(updates: readonly PolledUpdate[], current: number): number {
  let highest = current - 1;
  for (const update of updates) {
    if (update.update_id > highest) highest = update.update_id;
  }
  return highest + 1;
}

/** Ask once. Returns whatever is waiting, which is usually nothing. */
export async function pollOnce(
  config: TelegramConfig,
  offset: number,
  fetchImpl: typeof fetch = fetch,
  timeoutSeconds: number = POLL_TIMEOUT_S,
): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      }),
    });
  } catch {
    return { ok: false, failure: 'failed' };
  }

  if (response.status === 409) return { ok: false, failure: 'webhook-conflict' };
  if (response.status === 401) return { ok: false, failure: 'bad-token' };
  if (!response.ok) return { ok: false, failure: 'failed' };

  try {
    const body = (await response.json()) as { result?: unknown };
    return { ok: true, updates: Array.isArray(body.result) ? (body.result as PolledUpdate[]) : [] };
  } catch {
    return { ok: false, failure: 'failed' };
  }
}

/**
 * Unregister a webhook so polling can start.
 *
 * `drop_pending_updates` is deliberately false: updates that arrived while the
 * webhook was live are still the user's messages, and silently discarding
 * somebody's `/forget` because the developer switched transports is the wrong
 * default.
 */
export async function deleteWebhook(
  config: TelegramConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${config.botToken}/deleteWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Dispatch one polled update through the same handlers the webhook uses.
 *
 * The webhook path verifies a shared secret because anyone can POST to a public
 * URL. Polling has no equivalent check and needs none: the updates came back on
 * a connection *we* opened to Telegram, authenticated by the bot token. That is
 * the only difference between the two paths.
 */
export async function dispatch(
  update: PolledUpdate,
  config: TelegramConfig,
  context: Context,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const chatId = update.message?.chat?.id;
  if (typeof chatId !== 'number' || !Number.isFinite(chatId)) return null;

  const text = typeof update.message?.text === 'string' ? update.message.text : '';

  let reply: string;
  try {
    reply = await handle(parseCommand(text), chatId, context);
  } catch {
    reply = 'Something went wrong handling that. Try again shortly.';
  }

  await sendMessage(config, chatId, reply, fetchImpl);
  return reply;
}

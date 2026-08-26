/**
 * The webhook endpoint.
 *
 * One function, tying the three pure pieces together: verify the secret, read
 * the update, dispatch a command, send the reply.
 *
 * **It always answers 200**, even when it refuses or fails internally. Telegram
 * retries any non-2xx, so a handler that returns 500 on a bug turns one bad
 * update into a retry loop that lasts until the bug is fixed. The exception is
 * a failed secret check, which returns 403 precisely *because* it did not come
 * from Telegram and there is nothing to retry.
 *
 * `chat.id` enters the system here and nowhere else.
 */

import { handle, parseCommand } from './commands.js';
import { sendMessage, verifyWebhookSecret, type TelegramConfig } from './telegram.js';
import type { Context } from './commands.js';

/** The slice of Telegram's update object Wick reads. Everything else is ignored. */
interface Update {
  message?: {
    text?: unknown;
    chat?: { id?: unknown };
  };
}

export interface WebhookDeps extends Context {
  config: TelegramConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Handle one update.
 *
 * Returns the HTTP status to reply with, and — for tests — the text that was
 * sent, so a caller can assert on behaviour without a network.
 */
export async function handleUpdate(
  body: unknown,
  secretHeader: string | null,
  deps: WebhookDeps,
): Promise<{ status: number; sent: string | null }> {
  if (!verifyWebhookSecret(deps.config, secretHeader)) {
    return { status: 403, sent: null };
  }

  const chatId = readChatId(body);
  const text = readText(body);

  // An update with no chat, or a photo with no text, is not an error. Telegram
  // sends plenty of shapes Wick has no opinion about; acknowledging and moving
  // on is the correct response to all of them.
  if (chatId === null) return { status: 200, sent: null };

  let reply: string;
  try {
    reply = await handle(parseCommand(text), chatId, deps);
  } catch {
    // A failure here is ours. Tell the user something true and short rather
    // than leaving them staring at a bot that ignored them.
    reply = 'Something went wrong handling that. Try again shortly.';
  }

  const outcome = await sendMessage(deps.config, chatId, reply, deps.fetchImpl);

  // The user blocked the bot mid-conversation, which is unusual but not
  // impossible. Their data should not outlive their interest in it.
  if (!outcome.ok && outcome.reason === 'blocked') {
    try {
      await deps.store.forget(chatId);
    } catch {
      // Best effort. A failed cleanup must not turn into a Telegram retry.
    }
  }

  return { status: 200, sent: reply };
}

function readChatId(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;

  const id = (body as Update).message?.chat?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

function readText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';

  const text = (body as Update).message?.text;
  return typeof text === 'string' ? text : '';
}

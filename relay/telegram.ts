/**
 * The Telegram Bot API, as much of it as Wick uses.
 *
 * Three calls and one header check. There is no SDK here on purpose — the Bot
 * API is HTTPS and JSON, and a dependency that wraps it would be a third party
 * with access to the one credential the whole design exists to protect.
 *
 * **The bot token lives here and only here**, read from the environment on the
 * server. That is the entire point of ADR 0002: a user's machine holds a
 * revocable relay token, never this.
 */

/** What a send attempt did, in terms the caller can act on. */
export type SendOutcome =
  | { ok: true }
  /** The user blocked the bot or deleted the chat. The connection is dead. */
  | { ok: false; reason: 'blocked' }
  /** Telegram is rate limiting. `retryAfter` is seconds, if it said. */
  | { ok: false; reason: 'rate-limited'; retryAfter: number | null }
  /** Anything else: a 400, a 500, a network failure. */
  | { ok: false; reason: 'failed' };

export interface TelegramConfig {
  botToken: string;
  /** Shared with `setWebhook`; Telegram echoes it on every update. */
  webhookSecret: string;
}

/**
 * Post a message.
 *
 * **No `parse_mode`, deliberately.** The extension composes alert text and the
 * relay does not parse it (ADR 0003). Choosing Markdown or HTML here would mean
 * interpreting it — and a stray underscore in a perfectly ordinary alert would
 * come back as a 400 that the user experiences as a missing warning.
 */
export async function sendMessage(
  config: TelegramConfig,
  chatId: number,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }

  if (response.ok) return { ok: true };

  // 403 is the one failure that should change the database: the user is gone,
  // and retrying forever against them is how a dead row becomes a daily job.
  if (response.status === 403) return { ok: false, reason: 'blocked' };

  if (response.status === 429) {
    return { ok: false, reason: 'rate-limited', retryAfter: await readRetryAfter(response) };
  }

  return { ok: false, reason: 'failed' };
}

/** Telegram puts the backoff in the body, not in a header. */
async function readRetryAfter(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { parameters?: { retry_after?: unknown } };
    const seconds = body.parameters?.retry_after;
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Whether an incoming update really came from Telegram.
 *
 * `setWebhook` takes a `secret_token`, and Telegram then sends it back in this
 * header on every update. Without the check, the webhook URL *is* the
 * credential — anyone who learns it can forge `/forget` for any chat id they
 * can guess.
 *
 * Compared in constant time. The comparison is cheap and the alternative leaks
 * the secret one byte at a time to anyone willing to measure.
 */
export function verifyWebhookSecret(config: TelegramConfig, header: string | null): boolean {
  if (header === null) return false;
  return timingSafeEqual(header, config.webhookSecret);
}

function timingSafeEqual(a: string, b: string): boolean {
  // Length is not secret — it is fixed by configuration — but the contents are.
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Point Telegram at the webhook. Run once at deploy, not per request.
 *
 * `allowed_updates` is narrowed to messages: Wick has no inline mode, no
 * callback buttons, and no business receiving edits or channel posts. An update
 * type you do not handle is an update type you cannot mishandle.
 */
export async function setWebhook(
  config: TelegramConfig,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: config.webhookSecret,
        allowed_updates: ['message'],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

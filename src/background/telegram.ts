/**
 * The Telegram client — the only module that talks to anything but claude.ai.
 *
 * Wick posts alerts straight to `api.telegram.org` with a bot token the user
 * created and owns. ADR 0009 supersedes ADR 0002 for this: that record was
 * reasoning about one shared bot, where a leaked token exposes every connected
 * chat and only an operator can revoke it. A per-user bot leaks one person's own
 * alert history, and they revoke it themselves in @BotFather.
 *
 * **Outbound only.** Alerts go one way, so nothing here listens, polls, or holds
 * a connection open. The single exception is `discoverChat`, which reads
 * `getUpdates` exactly once to learn where to send — because asking a user to
 * find their own numeric chat id is the worst part of every bot integration and
 * there is no reason to reproduce it.
 *
 * Every function returns a result rather than throwing. Telegram being down,
 * slow, or refusing must never break collection or the interface — the local
 * notification path does not touch the network and is unaffected by anything
 * that happens here.
 *
 * **The origin is an optional host permission.** The manifest declares it under
 * `optional_host_permissions`, so every call below is blocked until the user
 * grants it from the Connect button, which is the only place with the user
 * gesture `chrome.permissions.request` needs.
 */

import { readSettings } from './store';

/** The Bot API origin. One copy, and `src/manifest.ts` must match it. */
export const TELEGRAM_ORIGIN = 'https://api.telegram.org';

/**
 * The same origin as a match pattern, for `chrome.permissions`.
 *
 * Exported because the grant has to be asked for from a user gesture, which
 * only the popup has. `src/manifest.ts` spells the same string out, and says
 * there why it cannot import this one.
 */
export const TELEGRAM_ORIGIN_PATTERN = `${TELEGRAM_ORIGIN}/*`;

/**
 * How long any call gets.
 *
 * Short on purpose. These sit behind a threshold alert, and an alert that
 * arrives late is worse than one that does not arrive — nothing downstream
 * waits on the answer, so a longer timeout only holds a worker awake for a
 * server that is not coming back.
 */
const TIMEOUT_MS = 6_000;

/** Why a call did not succeed. Callers branch on this, never on a status code. */
export type TelegramFailure =
  /** No token stored. The user has not set alerts up, so there was nothing to try. */
  | 'not-connected'
  /** Did not answer inside the timeout. */
  | 'timeout'
  /** Could not be reached at all — DNS, offline, or the missing host permission. */
  | 'offline'
  /** Telegram rejected the token. It is wrong, or was revoked in @BotFather. */
  | 'bad-token'
  /** The user has not messaged their bot, so there is no chat to send to. */
  | 'no-chat'
  /** The user blocked the bot, or deleted the chat. */
  | 'blocked'
  /** Over Telegram's rate limit. Do not retry. */
  | 'rate-limited'
  /** Reached, understood, refused — a 400, a 500, an unreadable body. */
  | 'rejected';

export type TelegramResult<T> = { ok: true; value: T } | { ok: false; failure: TelegramFailure };

/** What `discoverChat` hands back. `label` is display text only, and opaque to Wick. */
export interface ChatBinding {
  chatId: number;
  /** Where alerts will land, as Telegram describes it. For the settings screen. */
  label: string;
}

/**
 * Confirm a pasted token, and learn the bot's name.
 *
 * `getMe` is the cheapest call that proves a token works. Running it before
 * anything else means a mistyped token fails immediately with something the
 * user can act on, rather than silently at the first alert three days later.
 */
export async function verifyToken(botToken: string): Promise<TelegramResult<string>> {
  const result = await call(botToken, 'getMe', {});
  if (!result.ok) return result;

  const body = result.value as { username?: unknown; first_name?: unknown };
  const username = typeof body.username === 'string' ? body.username : null;
  const name = typeof body.first_name === 'string' ? body.first_name : null;

  // A 200 from getMe means the token is good even if the shape surprises us,
  // so an unreadable name is a display problem rather than a failed check.
  return { ok: true, value: username !== null ? `@${username}` : (name ?? 'your bot') };
}

/**
 * Find the chat to send to, from the message the user just sent their bot.
 *
 * Called **once**, from the connect flow. Wick never polls: alerts only travel
 * outwards, so after this there is nothing left to receive.
 *
 * `getUpdates` is called with no offset, which returns everything Telegram is
 * still holding. Telegram keeps updates for 24 hours, so a user who pastes a
 * token, wanders off for two days and then presses Connect gets `no-chat` —
 * which the settings screen turns into "send your bot a message, then try
 * again" rather than an error nobody can act on.
 *
 * The **most recent** message wins. A user retrying after a failed attempt has
 * several messages waiting, and the newest is the one they just sent.
 */
export async function discoverChat(botToken: string): Promise<TelegramResult<ChatBinding>> {
  const result = await call(botToken, 'getUpdates', { allowed_updates: ['message'], limit: 100 });
  if (!result.ok) return result;

  const updates = Array.isArray(result.value) ? result.value : [];

  let binding: ChatBinding | null = null;
  let highest = -1;

  for (const update of updates) {
    const parsed = readBinding(update);
    if (parsed === null) continue;
    if (parsed.updateId > highest) {
      highest = parsed.updateId;
      binding = parsed.binding;
    }
  }

  return binding === null ? { ok: false, failure: 'no-chat' } : { ok: true, value: binding };
}

/**
 * Post one alert.
 *
 * Takes the text and nothing else. The relay design carried an alert `kind`
 * because the server bucketed rate limits by it; with no server in the path
 * there is nothing to bucket, and a parameter kept only because something used
 * to read it is a question for whoever reads this next.
 *
 * Reads the token and chat itself rather than taking them, so no caller has to
 * hold a credential in a local variable. Nothing stored means the user has not
 * set alerts up, which is the normal case and not an error.
 *
 * **Never retries.** A `rate-limited` or `timeout` result is final. The alert
 * has already been recorded as sent and the local notification has already gone
 * out; retrying would turn one refused message into a storm.
 */
export async function send(text: string): Promise<TelegramResult<null>> {
  const settings = await current();
  if (settings === null) return { ok: false, failure: 'not-connected' };

  const result = await call(settings.botToken, 'sendMessage', {
    chat_id: settings.chatId,
    text,
    disable_web_page_preview: true,
  });

  return result.ok ? { ok: true, value: null } : result;
}

/* ---- Transport ----------------------------------------------------------- */

async function current(): Promise<{ botToken: string; chatId: number } | null> {
  try {
    const settings = await readSettings();
    const { botToken, chatId } = settings;
    if (typeof botToken !== 'string' || botToken === '') return null;
    if (typeof chatId !== 'number' || !Number.isFinite(chatId)) return null;
    return { botToken, chatId };
  } catch {
    // Storage failing is not this module's problem to report.
    return null;
  }
}

/**
 * One call, one place where failure is turned into a `TelegramFailure`.
 *
 * **No `parse_mode` is ever sent.** The extension composes alert text and this
 * module does not interpret it; choosing a markup dialect would be interpreting
 * it, and a stray underscore in an ordinary alert would come back as a 400 the
 * user experiences as a missing warning.
 *
 * Nothing here logs. A log line carrying the token, the chat or the message
 * body would put on the user's own disk exactly what this design exists to keep
 * off someone else's.
 */
async function call(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResult<unknown>> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // The token is in the path, never in a cookie: Telegram must not be able to
    // act on a request the browser made on its own.
    credentials: 'omit',
  };

  // Assigned rather than passed inline: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not the same as an absent key.
  const signal = timeoutSignal();
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_ORIGIN}/bot${botToken}/${method}`, init);
  } catch (error) {
    return { ok: false, failure: isAbort(error) ? 'timeout' : 'offline' };
  }

  if (!response.ok) return { ok: false, failure: failureForStatus(response.status) };

  try {
    const parsed = (await response.json()) as { ok?: unknown; result?: unknown };
    // Telegram answers 200 with `ok: false` for some refusals, so the status
    // alone is not the answer.
    if (parsed.ok !== true) return { ok: false, failure: 'rejected' };
    return { ok: true, value: parsed.result };
  } catch {
    return { ok: false, failure: 'rejected' };
  }
}

function failureForStatus(status: number): TelegramFailure {
  // 401 is a token that never worked or was revoked in @BotFather; 404 is what
  // a malformed token path produces, which is the same problem to the user.
  if (status === 401 || status === 404) return 'bad-token';
  if (status === 403) return 'blocked';
  if (status === 429) return 'rate-limited';
  return 'rejected';
}

/** Read a chat binding out of one update, or `null` if it is not a message. */
function readBinding(update: unknown): { updateId: number; binding: ChatBinding } | null {
  if (typeof update !== 'object' || update === null) return null;

  const shaped = update as {
    update_id?: unknown;
    message?: { chat?: { id?: unknown; username?: unknown; title?: unknown; first_name?: unknown } };
  };

  const updateId = typeof shaped.update_id === 'number' ? shaped.update_id : 0;
  const chat = shaped.message?.chat;
  if (chat === undefined || typeof chat.id !== 'number' || !Number.isFinite(chat.id)) return null;

  return { updateId, binding: { chatId: chat.id, label: labelFor(chat) } };
}

/**
 * A human label for where alerts land.
 *
 * Display only, and never used as an identifier. Falls back rather than
 * failing: a chat with no username and no title is still a perfectly good place
 * to send a message.
 */
function labelFor(chat: { username?: unknown; title?: unknown; first_name?: unknown }): string {
  if (typeof chat.username === 'string' && chat.username !== '') return `@${chat.username}`;
  if (typeof chat.title === 'string' && chat.title !== '') return chat.title;
  if (typeof chat.first_name === 'string' && chat.first_name !== '') return chat.first_name;
  return 'Telegram';
}

/**
 * `AbortSignal.timeout` where it exists.
 *
 * Present in every Chrome that runs MV3, but this file is not only loaded
 * there — a test runner or a future Firefox build may be older. Falling back to
 * no signal loses the timeout, not the request.
 */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}

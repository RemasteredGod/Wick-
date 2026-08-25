/**
 * The relay client — the only module that talks to anything other than
 * claude.ai.
 *
 * Wick posts alerts through a relay rather than to api.telegram.org directly,
 * because the direct route means keeping a Telegram bot token in
 * `chrome.storage.local`, which is plain JSON on disk and an unscoped bearer
 * credential the user cannot contain once it leaks. See
 * docs/decisions/0002-telegram-relay-not-bot-token.md for that decision and
 * docs/decisions/0003-telegram-relay-design.md for what the relay is.
 *
 * **There is no bot token in this file and there never will be.** The only
 * credential here is `Settings.relayToken`: per-installation, revocable in one
 * request, and useless for anything except posting to one chat.
 *
 * Every function returns a result rather than throwing. A relay that is down,
 * slow, or refusing must never break collection or the interface — the local
 * notification path does not touch the network and is unaffected by anything
 * that happens here.
 *
 * **The relay origin is an optional host permission, not an install-time one.**
 * The manifest declares it under `optional_host_permissions`, so every request
 * below is blocked until the user grants it from the Connect button — which is
 * the only place with the user gesture `chrome.permissions.request` needs. A
 * user who never sets up Telegram is never asked. See the "Manifest change"
 * section of ADR 0003.
 */

import { readSettings } from './store';
import type { AlertKind } from '~/core/types';

/**
 * The relay's registered API origin.
 *
 * Keep this identical to the optional host permission in `src/manifest.ts`, or
 * every call fails with an opaque network error.
 */
export const RELAY_ORIGIN = 'https://relay.usewick.lol';

/**
 * The same origin as a match pattern, for `chrome.permissions`.
 *
 * Exported because the grant has to be asked for from a user gesture, which
 * only the popup has. The pattern it passes must match the manifest's
 * `optional_host_permissions` entry character for character; `src/manifest.ts`
 * spells the same string out, and says there why it cannot import this one.
 */
export const RELAY_ORIGIN_PATTERN = `${RELAY_ORIGIN}/*`;

/** Versioned so a schema change does not break installations mid-flight. */
const API = `${RELAY_ORIGIN}/v1`;

/**
 * How long any relay call gets.
 *
 * Short on purpose. These calls sit behind a threshold alert, and an alert that
 * arrives late is worse than one that does not arrive — nothing downstream
 * waits on the answer, so the only thing a longer timeout buys is a worker held
 * awake for a server that is not coming back.
 */
const TIMEOUT_MS = 6_000;

/** Why a call did not succeed. Callers branch on this, never on a status code. */
export type RelayFailure =
  /** No token stored. The user has not connected, so there was nothing to try. */
  | 'not-connected'
  /** Did not answer inside the timeout. */
  | 'timeout'
  /** Could not be reached at all — DNS, offline, or the missing host permission. */
  | 'offline'
  /** The token is revoked or was never valid. The caller should clear it. */
  | 'unauthorised'
  /** Over the rate limit. Do not retry; see ADR 0003. */
  | 'rate-limited'
  /** Reached, understood, refused — a bad code, a 500, an unreadable body. */
  | 'rejected';

export type RelayResult<T> = { ok: true; value: T } | { ok: false; failure: RelayFailure };

/** What `connect` hands back. `label` is display text only, and opaque to Wick. */
export interface RelayConnection {
  /** The per-user token. Belongs in `Settings.relayToken` and nowhere else. */
  token: string;
  /** Where alerts will land, as the relay describes it. For the settings screen. */
  label: string;
}

/** One composed message. The extension writes the text; the relay never parses it. */
export interface RelayAlert {
  kind: AlertKind;
  /** The full message body, newlines and all. */
  text: string;
}

/**
 * Exchange a short-lived connect code for a per-user token.
 *
 * The code comes from the Telegram bot, which resolves the chat itself — so the
 * user never looks up a chat ID and never handles a bot credential. Codes are
 * single-use and expire in minutes; a rejected one is far more likely to be
 * stale than mistyped, which is what the settings screen tells the user.
 *
 * The caller persists the token. This module does not write storage, so a
 * connect that succeeds on the wire but fails to save leaves no orphan state
 * beyond one spent code.
 */
export async function connect(code: string): Promise<RelayResult<RelayConnection>> {
  const trimmed = code.trim();
  if (trimmed === '') return { ok: false, failure: 'rejected' };

  const result = await request('/connect', { code: trimmed });
  if (!result.ok) return result;

  const connection = asConnection(result.value);
  // A 200 with a body we cannot read is a broken relay, not a connection.
  return connection === null ? { ok: false, failure: 'rejected' } : { ok: true, value: connection };
}

/**
 * Post one alert.
 *
 * Reads the token itself rather than taking it, so no caller has to hold a
 * credential in a local variable to send a message. No token means the user has
 * not connected, which is the normal case and not an error.
 *
 * **Never retries.** A `rate-limited` or `timeout` result is final. The alert
 * has already been recorded as sent and the local notification has already gone
 * out; retrying would turn one refused message into a storm, which is how the
 * relay gets itself blocked for every user at once. See ADR 0003.
 */
export async function send(alert: RelayAlert): Promise<RelayResult<null>> {
  const token = await currentToken();
  if (token === null) return { ok: false, failure: 'not-connected' };

  const result = await request('/send', { kind: alert.kind, text: alert.text }, token);
  return result.ok ? { ok: true, value: null } : result;
}

/**
 * Revoke this installation's token.
 *
 * The caller clears `Settings.relayToken` regardless of what this returns.
 * Refusing to disconnect because a server is unreachable would be a worse
 * answer than disconnecting locally and letting the row expire on its own.
 */
export async function revoke(): Promise<RelayResult<null>> {
  const token = await currentToken();
  if (token === null) return { ok: false, failure: 'not-connected' };

  const result = await request('/revoke', {}, token);
  return result.ok ? { ok: true, value: null } : result;
}

/**
 * Delete everything the relay holds for this user's chat — every token, and any
 * unredeemed codes.
 *
 * Stronger than `revoke`, which only ends this installation's connection. The
 * bot's `/forget` command does the same thing from inside Telegram, for a user
 * who has already uninstalled the extension and has no token left to present.
 */
export async function deleteAccount(): Promise<RelayResult<null>> {
  const token = await currentToken();
  if (token === null) return { ok: false, failure: 'not-connected' };

  const result = await request('/delete', {}, token);
  return result.ok ? { ok: true, value: null } : result;
}

/* ---- Transport ----------------------------------------------------------- */

async function currentToken(): Promise<string | null> {
  try {
    const settings = await readSettings();
    const token = settings.relayToken;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    // Storage failing is not this module's problem to report.
    return null;
  }
}

/**
 * One request, one place where failure is turned into a `RelayFailure`.
 *
 * Nothing here logs. A log line carrying a token, a chat, or a message body
 * would put on the user's own disk exactly what ADR 0003 promises the relay does
 * not keep on ours.
 */
async function request(
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<RelayResult<unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // Credentials are carried in the header, never in a cookie: the relay must
    // not be able to act on a request the browser made on its own.
    credentials: 'omit',
  };

  // Assigned rather than passed inline: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not the same as an absent key.
  const signal = timeoutSignal();
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, init);
  } catch (error) {
    return { ok: false, failure: isAbort(error) ? 'timeout' : 'offline' };
  }

  if (!response.ok) return { ok: false, failure: failureForStatus(response.status) };

  // 204s and empty 202s are the normal success shape for three of the four
  // endpoints, so an unreadable body is only a problem if the caller wanted one.
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: true, value: null };
  }
}

function failureForStatus(status: number): RelayFailure {
  if (status === 401 || status === 403) return 'unauthorised';
  if (status === 429) return 'rate-limited';
  return 'rejected';
}

/**
 * `AbortSignal.timeout` where it exists.
 *
 * Present in every Chrome that runs MV3, but the extension is not the only
 * place this file is loaded — a test runner or a future Firefox build may be
 * older. Falling back to no signal loses the timeout, not the request.
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

/** Read a connect response without trusting its shape. */
function asConnection(value: unknown): RelayConnection | null {
  if (typeof value !== 'object' || value === null) return null;

  const body = value as { token?: unknown; label?: unknown };
  if (typeof body.token !== 'string' || body.token === '') return null;

  return {
    token: body.token,
    label: typeof body.label === 'string' && body.label !== '' ? body.label : 'Telegram',
  };
}

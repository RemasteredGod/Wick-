/**
 * Leaving the board.
 *
 * `POST /api/leave`, `Authorization: Bearer <token>`, body `{}`. Deletes the
 * profile, email, every daily row, and every token for that account. Profile
 * pages are uncached; an already cached aggregate board may remain visible only
 * until its at-most-sixty-second freshness period expires.
 *
 * An unknown token answers 200. It means the profile is already gone — by an
 * earlier leave, or by a request that timed out after the delete landed — and
 * the caller's desired state is the actual state.
 */

import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import {
  bearerToken,
  hasJsonContentType,
  readJson,
  sendJson,
  type JsonReadResult,
  type Req,
  type Res,
} from '../server/http.js';

/** The route carries only `{}`; the headroom permits whitespace. */
const LEAVE_BODY_LIMIT = 16;

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'method-not-allowed' }, 'no-store', req.method === 'HEAD');
    return;
  }

  const token = bearerToken(req);
  if (token === null) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (!hasJsonContentType(req)) {
    sendJson(res, 415, { error: 'unsupported-media-type' });
    return;
  }

  const parsed = await readJson(req, LEAVE_BODY_LIMIT);
  if (!parsed.ok) {
    sendReadError(res, parsed);
    return;
  }
  if (!isExactLeaveBody(parsed.value)) {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    await store.forget(token);
    sendJson(res, 200, { left: true });
  } catch {
    // The extension retains its token after this generic failure, so retrying
    // later can still complete the delete instead of orphaning the profile.
    sendJson(res, 503, { error: 'unavailable' });
  }
}

function isExactLeaveBody(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 0
  );
}

function sendReadError(res: Res, result: Extract<JsonReadResult, { ok: false }>): void {
  if (result.error === 'too-large') {
    sendJson(res, 413, { error: 'payload-too-large' });
    return;
  }
  sendJson(res, 400, { error: 'bad-request' });
}

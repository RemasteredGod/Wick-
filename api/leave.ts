/**
 * Leaving the board.
 *
 * `POST /api/leave`, `Authorization: Bearer <token>`. Deletes the profile and
 * every row behind it.
 *
 * **Hard delete, no tombstone.** A participant who leaves is gone from the next
 * board request and the name they held returns to the pool. Nothing is kept to
 * prove they were ever there, which is the only version of "leave" worth
 * offering on a board nobody was asked to join.
 *
 * An unknown token answers 200. It means the profile is already gone — by an
 * earlier leave, or by a request that timed out after the delete landed — and
 * the caller's desired state is the actual state. A 401 here would strand an
 * extension holding a dead token, unable to clear it.
 */

import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { bearerToken, sendJson, type Req, type Res } from '../server/http.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }

  const token = bearerToken(req);
  if (token === null) {
    sendJson(res, 401, { error: 'unauthorized' }, 'no-store');
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    await store.forget(token);
    sendJson(res, 200, { left: true }, 'no-store');
  } catch {
    // Reported rather than swallowed: the extension keeps its token on a failed
    // leave, so pressing Leave again later still works. Answering 200 here
    // would clear it locally and orphan the rows for good.
    sendJson(res, 503, { error: 'unavailable' }, 'no-store');
  }
}

/**
 * Publishing one day.
 *
 * `POST /api/submit`, `Authorization: Bearer <token>`, body `{ day, messages }`.
 *
 * A seam: authenticate the token, validate the body, upsert the row. The
 * validation lives in `leaderboard/submission.ts` and is tested without a
 * network; nothing here decides what a plausible day looks like.
 *
 * **Partial acceptance is not a thing.** A body that is missing, malformed or
 * out of range contributes nothing and says so — ADR 0005's rule, which is the
 * one part of the old token-counting design that survived the metric change
 * unaltered.
 */

import { readSubmission } from '../leaderboard/submission.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { bearerToken, readJson, sendJson, type Req, type Res } from '../server/http.js';

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

  const submission = readSubmission(await readJson(req));
  if (!submission.ok) {
    // The rejection reason travels back because the only caller is Wick's own
    // extension and a shape mismatch is a bug worth being able to see. It names
    // a category, never a value from the body.
    sendJson(res, 400, { error: submission.rejection }, 'no-store');
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));

    // Authenticated by looking the token up, not by trusting it. An unknown
    // token is a 401 rather than a silently discarded write, so an extension
    // holding a token for a deleted profile finds out instead of publishing
    // into nothing forever.
    const profile = await store.profile(token);
    if (profile === null) {
      sendJson(res, 401, { error: 'unauthorized' }, 'no-store');
      return;
    }

    await store.saveDaily(token, submission.row);
    sendJson(res, 200, { day: submission.row.day, name: profile.name }, 'no-store');
  } catch {
    sendJson(res, 503, { error: 'unavailable' }, 'no-store');
  }
}

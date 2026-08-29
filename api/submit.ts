/**
 * Publishing one day.
 *
 * `POST /api/submit`, `Authorization: Bearer <token>`, body `{ day, messages }`.
 * The accepted row remains exactly those two fields; account identity comes
 * only from the bearer token.
 */

import { readSubmission } from '../leaderboard/submission.js';
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

/** Enough for the exact two-field payload and harmless whitespace, not a general document. */
const SUBMIT_BODY_LIMIT = 128;

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

  const parsed = await readJson(req, SUBMIT_BODY_LIMIT);
  if (!parsed.ok) {
    sendReadError(res, parsed);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const submission = readSubmission(parsed.value, today);
  if (!submission.ok) {
    // Categories help Wick diagnose its own payload without reflecting values or internals.
    sendJson(res, 400, { error: submission.rejection });
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));

    // An unknown token is explicit, so a browser holding a token for a deleted
    // profile does not silently publish into nothing forever.
    const profile = await store.profile(token);
    if (profile === null) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    await store.saveDaily(token, submission.row);
    sendJson(res, 200, { day: submission.row.day, name: profile.name });
  } catch {
    sendJson(res, 503, { error: 'unavailable' });
  }
}

function sendReadError(res: Res, result: Extract<JsonReadResult, { ok: false }>): void {
  if (result.error === 'too-large') {
    sendJson(res, 413, { error: 'payload-too-large' });
    return;
  }
  sendJson(res, 400, { error: 'bad-request' });
}

/**
 * Joining the board.
 *
 * `POST /api/enroll` with `{ email }`. Answers `{ token, name }`.
 *
 * **The email is the profile's primary key**, so one Claude account is one
 * public profile across every browser it signs into. Nothing verifies the
 * address: it is an identifier observed by the extension, never a credential.
 */

import { randomInt } from 'node:crypto';
import { readAccountEmail } from '../leaderboard/account.js';
import { assignName } from '../leaderboard/names.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import {
  hasJsonContentType,
  readJson,
  sendJson,
  type JsonReadResult,
  type Req,
  type Res,
} from '../server/http.js';

/** Room for the longest accepted email plus JSON syntax, but not an arbitrary document. */
const ENROLL_BODY_LIMIT = 512;

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'method-not-allowed' }, 'no-store', req.method === 'HEAD');
    return;
  }

  if (!hasJsonContentType(req)) {
    sendJson(res, 415, { error: 'unsupported-media-type' });
    return;
  }

  const parsed = await readJson(req, ENROLL_BODY_LIMIT);
  if (!parsed.ok) {
    sendReadError(res, parsed);
    return;
  }

  const value = parsed.value;
  if (!isExactEnrollBody(value)) {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }

  const email = readAccountEmail(value.email);
  if (email === null) {
    sendJson(res, 400, { error: 'bad-email' });
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    const enrolment = await store.enroll(email, () => assignName(() => false, random) ?? fallback());

    if (enrolment === null) {
      sendJson(res, 503, { error: 'no-name-available' });
      return;
    }

    // A cached enrolment would hand one participant's token to the next caller.
    sendJson(res, 200, { token: enrolment.token, name: enrolment.name });
  } catch {
    sendJson(res, 503, { error: 'unavailable' });
  }
}

function isExactEnrollBody(value: unknown): value is { email: unknown } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'email';
}

function sendReadError(res: Res, result: Extract<JsonReadResult, { ok: false }>): void {
  if (result.error === 'too-large') {
    sendJson(res, 413, { error: 'payload-too-large' });
    return;
  }
  sendJson(res, 400, { error: 'bad-request' });
}

/** A CSPRNG in [0, 1). */
function random(): number {
  return randomInt(0, 2 ** 30) / 2 ** 30;
}

/** A vanishingly unlikely fallback if every reserved-word attempt is exhausted. */
function fallback(): string {
  return `wick-${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

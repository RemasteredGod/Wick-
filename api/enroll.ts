/**
 * Joining the board.
 *
 * `POST /api/enroll` with an empty body. Answers `{ token, name }`.
 *
 * **The request carries nothing, and that is the design.** No email, no handle,
 * no account id, no claude.ai anything — the extension's only contribution to
 * its own identity is holding the token afterwards. There is consequently
 * nothing to recover a lost token with, which is stated plainly in the settings
 * screen rather than softened.
 *
 * The name is assigned here, never chosen. `assignName` refuses reserved words
 * and confusable skeletons before proposing anything, and the store's unique
 * index on the folded form is what settles a race between two enrolments that
 * propose the same one.
 */

import { randomInt } from 'node:crypto';
import { assignName } from '../leaderboard/names.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { sendJson, type Req, type Res } from '../server/http.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));

    // The store decides whether a proposal is free, because only it can see
    // what is already stored. `isTaken` is answered `false` here and the unique
    // index does the real work — see the note on `enroll` in supabase-store.ts.
    const enrolment = await store.enroll(() => assignName(() => false, random) ?? fallback());

    if (enrolment === null) {
      sendJson(res, 503, { error: 'no-name-available' });
      return;
    }

    // `no-store`, and it matters more here than anywhere else on the board: a
    // cached enrolment would hand one participant's token to the next caller.
    sendJson(res, 200, enrolment, 'no-store');
  } catch {
    sendJson(res, 503, { error: 'unavailable' }, 'no-store');
  }
}

/**
 * A CSPRNG in [0, 1).
 *
 * `Math.random` is seeded from the clock in some engines. The assigned name is
 * public and permanent, so a name predictable from the moment somebody joined
 * would be a fact about them that the board did not mean to publish.
 */
function random(): number {
  return randomInt(0, 2 ** 30) / 2 ** 30;
}

/**
 * A name for the case where `assignName` exhausts its own attempts.
 *
 * It returns `null` after twelve tries against the reserved list, which with
 * `isTaken` always answering false can only happen by drawing reserved words
 * twelve times running. Vanishingly unlikely, but `enroll` needs a string, and
 * a thrown error here would read to the user as "the board is down".
 */
function fallback(): string {
  return `wick-${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

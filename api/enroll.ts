/**
 * Joining the board.
 *
 * `POST /api/enroll` with `{ email }`. Answers `{ token, name }`.
 *
 * **The email is the profile's primary key**, so one Claude account is one
 * public profile across every browser it signs into. A second browser enrolling
 * with the same address gets its own token and the account's existing name —
 * there is no link step, and nothing for the user to do.
 *
 * **Nothing verifies the address.** The extension read it off claude.ai's own
 * sidebar; it cannot prove the account is the caller's, and there is no Claude
 * API to check against. So possession of an email is enough to claim its
 * profile. That is inherent to syncing from an identifier the extension merely
 * observed, it is the owner's accepted trade for a board that needs no setup,
 * and PRIVACY.md says so to the user rather than leaving it to be discovered.
 *
 * The name is assigned here, never chosen, and only for an account that has no
 * profile yet. `assignName` refuses reserved words and confusable skeletons
 * before proposing anything, and the store's unique index on the folded form
 * settles a race between two enrolments that propose the same one.
 */

import { randomInt } from 'node:crypto';
import { readAccountEmail } from '../leaderboard/account.js';
import { assignName } from '../leaderboard/names.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { readJson, sendJson, type Req, type Res } from '../server/http.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }

  const body = await readJson(req);
  const email = readAccountEmail((body as { email?: unknown } | null)?.email);
  if (email === null) {
    sendJson(res, 400, { error: 'bad-email' }, 'no-store');
    return;
  }

  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    const enrolment = await store.enroll(email, () => assignName(() => false, random) ?? fallback());

    if (enrolment === null) {
      sendJson(res, 503, { error: 'no-name-available' }, 'no-store');
      return;
    }

    // `no-store`, and it matters more here than anywhere else on the board: a
    // cached enrolment would hand one participant's token to the next caller.
    sendJson(res, 200, { token: enrolment.token, name: enrolment.name }, 'no-store');
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

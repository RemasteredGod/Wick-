/**
 * What the board needs from storage, and nothing more.
 *
 * A port, not an implementation. The handlers are written against this
 * interface so they can be tested against a fake, and so swapping the database
 * is one adapter rather than a rewrite.
 *
 * **Identity is a bearer token, and only a bearer token.** There was a Telegram
 * chat id here; every method took one, because a chat was how somebody joined.
 * Enrolment happens from the extension now, so a participant is whoever holds
 * the token the board minted for them — there is no account, no email, no
 * handle, and nothing to recover it with. Losing the token means losing the
 * profile, which is the price of the board knowing nothing about anybody.
 *
 * Note what is absent. There is no method to read when a participant submitted,
 * from where, or how often — only which calendar days they claimed and what
 * they claimed for them. An interface that cannot express a thing is a stronger
 * guarantee than a policy saying nobody should ask for it.
 */

import type { Day, Period } from '../leaderboard/periods.js';
import type { Standing } from '../leaderboard/ranking.js';
import type { DailyRow } from '../leaderboard/submission.js';

/** A leaderboard profile. One per participant token. */
export interface Profile {
  name: string;
}

/** What enrolment hands back. The token is shown to its owner exactly once. */
export interface Enrolment {
  token: string;
  name: string;
}

export interface BoardStore {
  /* ---- Joining ----------------------------------------------------------- */

  /**
   * Mint a participant token and assign a name.
   *
   * The store owns both because both must be unique against what is already
   * stored, and only the store can see that. `assign` proposes names — it is
   * `assignName` from leaderboard/names.ts with the randomness bound — and the
   * implementation retries with a fresh proposal on a collision.
   *
   * Returns `null` when no free name was found, which is a full namespace
   * rather than a failed request and is reported as such.
   */
  enroll(assign: () => string): Promise<Enrolment | null>;

  /* ---- Submitting -------------------------------------------------------- */

  /** The profile a token belongs to, or `null` if it belongs to none. */
  profile(token: string): Promise<Profile | null>;

  /**
   * Record one day for one participant.
   *
   * **Upsert, never insert.** A resubmission replaces the day rather than
   * adding to it, so a retried request corrects a total instead of inflating
   * one.
   */
  saveDaily(token: string, row: DailyRow): Promise<void>;

  /* ---- Boards ------------------------------------------------------------ */

  board(period: Period, today: Day, size: number): Promise<Standing[]>;
  standing(name: string, period: Period, today: Day): Promise<Standing | null>;

  /* ---- Leaving ----------------------------------------------------------- */

  /**
   * Delete the profile and every row belonging to a token.
   *
   * There is no soft-delete and no tombstone. A participant who leaves is gone
   * from the board on the next request, and the name they held returns to the
   * pool — nothing is kept to prove they were ever there.
   */
  forget(token: string): Promise<void>;
}

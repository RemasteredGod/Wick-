/**
 * What the board needs from storage, and nothing more.
 *
 * A port, not an implementation. The handlers are written against this
 * interface so they can be tested against a fake, and so swapping the database
 * is one adapter rather than a rewrite.
 *
 * **Identity is the Claude account email; authorisation is a bearer token.**
 * The two are separate on purpose. The email is the profile's primary key, so
 * one account is one profile across every browser it signs into with nothing
 * for the user to do. The token is what a browser presents on each daily
 * submission, so the email travels once — at enrolment — rather than every day.
 *
 * The token is **not** a security boundary: `enroll` issues one to anyone who
 * presents the email, and nothing verifies that the caller owns it. That is
 * inherent to syncing from an identifier the extension merely read off a page,
 * and it is stated here rather than left for someone to discover.
 *
 * Note what is absent. There is no method to read when a participant submitted,
 * from where, or how often — only which calendar days they claimed and what
 * they claimed for them. An interface that cannot express a thing is a stronger
 * guarantee than a policy saying nobody should ask for it.
 */

import type { Day, Period } from '../leaderboard/periods.js';
import type { Standing } from '../leaderboard/ranking.js';
import type { DailyRow } from '../leaderboard/submission.js';

/**
 * Everything one profile page needs, from one read.
 *
 * A rank in each of the three periods plus the streak. Bundled rather than
 * fetched a period at a time because an adapter answers a standing by loading
 * every participant and ranking them — asking three times means doing that
 * three times for one page, and the streak needs the day-by-day rows that a
 * `Standing` has already summarised away.
 */
export interface ProfileStats {
  standings: Map<Period, Standing | null>;
  /** Consecutive submitted days ending at the most recent one. */
  streak: number;
  /**
   * The all-time leader's message total.
   *
   * Carried so a profile can draw its share of the board without a second
   * query — the ranking pass has already sorted everyone, so the number is
   * free here and would cost a full read anywhere else. Zero when nobody has
   * published anything.
   */
  leaderTotal: number;
}

/** A leaderboard profile. One per Claude account. */
export interface Profile {
  name: string;
}

/**
 * What enrolment hands back.
 *
 * `existing` distinguishes "this account already had a profile and you are now
 * a second browser on it" from "this account is new". The popup renders the
 * same either way; the handler uses it to keep a repeat enrolment from reading
 * as a fresh join in the logs of anyone debugging it.
 */
export interface Enrolment {
  token: string;
  name: string;
  existing: boolean;
}

export interface BoardStore {
  /* ---- Joining ----------------------------------------------------------- */

  /**
   * Bind a browser to the profile for `email`, creating it if there is none.
   *
   * **Idempotent per account, not per browser.** A second browser signed into
   * the same account gets its own token and the *same* name — that is the whole
   * point of keying profiles on the email. A caller must never end up with two
   * profiles for one account, so this cannot be implemented as a blind insert.
   *
   * Profile creation (or lookup) and token binding are one atomic operation.
   * A token failure must not retain a new profile or its email, and concurrent
   * first enrolments for one email must converge on that account's single row.
   *
   * `assign` proposes names — `assignName` from leaderboard/names.ts with the
   * randomness bound — and the implementation retries on a collision. It is
   * only consulted when the account has no profile yet.
   *
   * Returns `null` when no free name was found, which is a full namespace
   * rather than a failed request and is reported as such.
   */
  enroll(email: string, assign: () => string): Promise<Enrolment | null>;

  /* ---- Submitting -------------------------------------------------------- */

  /** The profile a token belongs to, or `null` if it belongs to none. */
  profile(token: string): Promise<Profile | null>;

  /**
   * Record one day for the account a token belongs to.
   *
   * **Upsert, never insert.** A resubmission replaces the day rather than
   * adding to it, so a retried request corrects a total instead of inflating
   * one — and two browsers on one account converge on a single row for the day
   * rather than double-counting it.
   */
  saveDaily(token: string, row: DailyRow): Promise<void>;

  /* ---- Boards ------------------------------------------------------------ */

  board(period: Period, today: Day, size: number): Promise<Standing[]>;

  /**
   * The three standings and the streak for one name, or `null` if nobody holds
   * it.
   *
   * `null` covers "never taken", "left", and "joined but has published
   * nothing", and callers must not be able to tell those apart — a page that
   * distinguished them would let anyone enumerate who had quit.
   */
  stats(name: string, today: Day): Promise<ProfileStats | null>;

  /* ---- Leaving ----------------------------------------------------------- */

  /**
   * Delete the profile, every row, and **every browser's token** for the
   * account a token belongs to.
   *
   * Account-wide rather than browser-wide, and that is the right scope: Leave
   * says the profile is gone, and a version that only unbound the browser it
   * was pressed in would leave the public page up and another browser still
   * publishing to it.
   *
   * The profile, rows, and tokens must disappear atomically. A storage adapter
   * may rely on verified cascading foreign keys, but it must not expose a
   * sequence of independently committable deletes that can stop halfway.
   * Unknown and already-forgotten tokens are successful no-ops.
   *
   * There is no soft-delete and no tombstone. The name returns to the pool and
   * nothing is kept to prove the account was ever there.
   */
  forget(token: string): Promise<void>;
}

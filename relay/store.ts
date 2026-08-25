/**
 * What the bot needs from storage, and nothing more.
 *
 * A port, not an implementation. The command handlers are written against this
 * interface so they can be tested against a fake, and so swapping the database
 * — D1, Supabase, anything — is one adapter rather than a rewrite. That matters
 * more than usual here: ADR 0006 chose Cloudflare D1 and the project is now
 * looking at Supabase, so the seam is load-bearing rather than decorative.
 *
 * Note what is absent. There is no method to read a user's alert history, their
 * IP, or a timestamp finer than a day, because ADR 0003 promises the relay does
 * not keep those. An interface that cannot express a thing is a stronger
 * guarantee than a policy saying nobody should ask for it.
 */

import type { Day, Period } from '../leaderboard/periods';
import type { Standing } from '../leaderboard/ranking';

/** A leaderboard profile. One per chat, however many installations it has. */
export interface Profile {
  name: string;
  /** Weekly digest, off unless the user asked for it (ADR 0006). */
  digest: boolean;
}

export interface RelayStore {
  /* ---- Connecting -------------------------------------------------------- */

  /** Record a freshly minted code against the chat that asked for it. */
  saveCode(chatId: number, code: string, mintedAt: number): Promise<void>;

  /* ---- Profiles ---------------------------------------------------------- */

  profile(chatId: number): Promise<Profile | null>;
  createProfile(chatId: number, name: string): Promise<void>;
  setName(chatId: number, name: string): Promise<void>;
  setDigest(chatId: number, on: boolean): Promise<void>;

  /** Whether a *folded* name is held. Callers must fold before asking. */
  isNameTaken(folded: string): Promise<boolean>;

  /* ---- Renames (ADR 0007) ------------------------------------------------ */

  /**
   * Spend a paid rename code.
   *
   * Returns false for a code that is unknown or already redeemed. The payment
   * that produced it is not visible here and must not become so — the whole
   * anonymity argument in ADR 0007 rests on nothing joining the two.
   */
  redeemRenameCode(code: string): Promise<boolean>;

  /* ---- Boards ------------------------------------------------------------ */

  board(period: Period, today: Day, size: number): Promise<Standing[]>;
  standing(name: string, period: Period, today: Day): Promise<Standing | null>;

  /* ---- Leaving ----------------------------------------------------------- */

  /**
   * Delete the profile and every leaderboard row for a chat, leaving alert
   * connections intact. ADR 0006: opting out of the board is not disconnecting.
   */
  deleteProfile(chatId: number): Promise<void>;

  /**
   * Delete everything for a chat — connections, codes, profile, rows, pending
   * digest work. ADR 0003's `/forget`, available without a token because a user
   * who has uninstalled the extension has nothing left to authenticate with.
   */
  forget(chatId: number): Promise<void>;
}

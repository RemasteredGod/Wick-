/**
 * The account identifier, and what counts as one.
 *
 * The board keys a profile on the Claude account's email address. That makes
 * one account one profile across every browser it signs into, with no link step
 * — and it makes this file the whole of the identity model, so what it accepts
 * and how it normalises are worth stating in one place rather than at each call
 * site.
 *
 * **Nothing here authenticates anything.** The extension reads the address off
 * claude.ai's own sidebar and cannot prove the account is the caller's; there
 * is no Claude API to check it against. `readAccountEmail` decides whether a
 * string is *shaped* like an address, not whether it is anybody's. See the note
 * in `server/store.ts`.
 *
 * Pure. Takes `unknown` because it runs on a request body and on a DOM read.
 */

/**
 * The longest address the board will hold.
 *
 * RFC 5321 caps a path at 254 octets, and nothing about a Claude account will
 * approach it. The cap is here so a request body cannot make the primary key
 * arbitrarily large.
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Code points that must never reach the primary key.
 *
 * Whitespace, the C0 controls, DEL — and the zero-width characters, which are
 * the dangerous half. An address carrying U+200B renders identically to the
 * same address without it and compares unequal, so accepting one would let two
 * keys that look like one account exist side by side. `fold` in names.ts strips
 * exactly this set for the same reason.
 *
 * Written as a code-point test rather than a regular expression, and with the
 * boundaries named rather than pasted: a zero-width character inside a
 * character class is invisible in an editor and in `sed`, so the class would
 * read as one thing to a reviewer and mean another.
 *
 * Everything else above U+007F is left alone. An internationalised address is
 * still an address, and rejecting one would lock its owner out of the board.
 */
function isForbidden(code: number): boolean {
  if (code <= 0x20 || code === 0x7f) return true;
  // Zero-width space, ZWNJ, ZWJ, and the two direction marks.
  if (code >= 0x200b && code <= 0x200f) return true;
  // Word joiner, and the byte-order mark in its zero-width-no-break-space role.
  return code === 0x2060 || code === 0xfeff;
}

function hasForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    if (isForbidden(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Whether a string is shaped like an address the board can key on.
 *
 * Deliberately loose. A strict RFC 5322 grammar is famously most of a parser,
 * and being strict here would reject somebody's real address and lock them out
 * of a leaderboard — a much worse failure than accepting a string that happens
 * to look like an address and belongs to nobody. What it does insist on is that
 * there is exactly one `@`, something either side of it, a dot in the domain,
 * and nothing that would make two spellings of one key compare unequal.
 */
export function isAccountEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  if (value !== value.trim()) return false;
  if (hasForbiddenCharacter(value)) return false;

  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;

  const domain = value.slice(at + 1);
  if (domain.length === 0 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;

  return true;
}

/**
 * The form the board stores and compares on.
 *
 * Trimmed and lowercased, and that is all. **Not** dot-stripped, and not
 * plus-tag-stripped: `a.b@gmail.com` and `ab@gmail.com` are the same mailbox at
 * Gmail and different mailboxes almost everywhere else, so folding them would
 * merge two people's profiles at every provider that treats dots as
 * significant. Merging two accounts into one profile is a worse failure than
 * letting one person hold two, and only one of the two is recoverable.
 *
 * Case is different: the domain is case-insensitive by specification, and no
 * mail provider in practice distinguishes local parts by case. Lowercasing is
 * what stops `Ash@Example.com` and `ash@example.com` from becoming two profiles
 * for one account the first time somebody's sidebar renders it differently.
 */
export function normaliseAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Read an account email out of an untrusted value, normalised, or `null`.
 *
 * The one entry point. Every path that takes an email from a request body or a
 * DOM read goes through here, so the check and the normalisation cannot drift
 * apart — a validator that accepted a spelling the normaliser then changed
 * would write a key nothing could look up again.
 */
export function readAccountEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalised = normaliseAccountEmail(value);
  return isAccountEmail(normalised) ? normalised : null;
}

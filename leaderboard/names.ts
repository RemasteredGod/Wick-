/**
 * Assigning names, and refusing bad ones.
 *
 * ADR 0007: every profile is created with a randomly assigned name, and
 * changing it is the one thing the project sells. Two consequences meet in this
 * file. The assigned name must never be derived from anything the user gave
 * Telegram — not their username, title, first name or id — and the *purchased*
 * name is public, durable, and therefore a moderation surface.
 *
 * "Someone will pay a dollar to be called `anthropic`" is not a hypothetical.
 * The reserved list and the confusable folding below are the whole defence, so
 * they are specified here rather than left to a database constraint.
 *
 * Pure. Randomness is injected, so tests are deterministic and the caller owns
 * the source.
 */

import { ADJECTIVES, NOUNS } from './words';

/** Bounds for a purchased name. Long enough to be a name, short enough for a card. */
export const MIN_LENGTH = 3;
export const MAX_LENGTH = 24;

/**
 * Names nobody may hold.
 *
 * Three groups, and each is here for its own reason:
 *
 * - **Routes.** Every path segment ADR 0008 uses. A name that shadows a route
 *   is not an impersonation problem, it is a broken site.
 * - **Identity.** The project, the model, and the company. A profile at
 *   `/u/anthropic` is a claim to be someone, whoever paid for it.
 * - **Authority.** Words that make a stranger's page look official.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  // Routes — keep in step with ADR 0008.
  'u', 'api', 'v1', 'about', 'privacy', 'terms', 'month', 'all', 'week',
  'board', 'profile', 'static', 'assets', 'robots', 'favicon', 'sitemap',
  // Identity.
  'wick', 'usewick', 'claude', 'anthropic', 'claudecode', 'botfather', 'telegram',
  // Authority.
  'admin', 'administrator', 'support', 'help', 'staff', 'team', 'official',
  'moderator', 'mod', 'system', 'security', 'billing', 'payments', 'root',
  'null', 'undefined', 'anonymous', 'deleted',
]);

/** Why a name was refused. */
export type NameRejection =
  | 'too-short'
  | 'too-long'
  | 'bad-characters'
  | 'bad-shape'
  | 'reserved'
  | 'taken';

export type NameResult = { ok: true; name: string } | { ok: false; rejection: NameRejection };

/**
 * The form a name is compared in.
 *
 * Uniqueness is decided on this, never on the raw string. Without it, `ash`,
 * `Ash`, `a5h`, `as_h` and a variant carrying a zero-width space are five rows
 * that read as one name — which is exactly how impersonation works on a public
 * profile page.
 *
 * The folds, in order:
 *
 * - **NFKC**, which collapses the compatibility forms — fullwidth Latin, the
 *   mathematical alphanumerics — onto plain ASCII.
 * - **Zero-width characters removed.** They are invisible, so a name carrying
 *   one is indistinguishable on screen from the same name without it.
 * - **Separators unified.** Hyphen and underscore read alike at a glance and
 *   neither carries meaning, so they fold to one.
 * - **Digits that are letter shapes.** 0/o, 1/l, 3/e, 5/s.
 *
 * This deliberately over-matches. Refusing a name that merely *resembles* a
 * taken one costs its would-be owner a different name; allowing it costs the
 * existing owner their identity.
 */
export function fold(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    // Escaped rather than written literally: these characters are invisible,
    // so a literal class here would be a line nobody can review.
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/_/g, '-')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's');
}

/**
 * The aggressive form, used **only** against the reserved list.
 *
 * `fold` cannot catch `adm1n`. It maps `1` to `l`, giving `admln`, while the
 * reserved word `admin` keeps its `i` — the two never meet. Closing that needs
 * `i`, `l` and `1` treated as one character, and separators dropped entirely so
 * `a-d-m-i-n` cannot walk around the list either.
 *
 * That is too blunt for deciding uniqueness *between users*: it also collides
 * `silt` with `slit`, and `ali` with the reserved `all`. Against a fixed list of
 * about forty words the cost of a false positive is that somebody picks a
 * different name; between users it would be one person taking another's. So the
 * two folds are kept separate and this one is never used for the taken check.
 */
export function skeleton(name: string): string {
  return fold(name)
    .replace(/i/g, 'l')
    .replace(/-/g, '');
}

/** Reserved words in skeleton form, so the comparison is symmetric. */
const RESERVED_SKELETONS: ReadonlySet<string> = new Set([...RESERVED].map(skeleton));

/**
 * Check a name a user is trying to buy.
 *
 * `isTaken` is asked with the *folded* form, so the caller's uniqueness index
 * must be built on `fold` output too. Passing raw names there would make every
 * fold above decorative.
 */
export function validateName(input: string, isTaken: (folded: string) => boolean): NameResult {
  const name = input.trim().toLowerCase();

  if (name.length < MIN_LENGTH) return { ok: false, rejection: 'too-short' };
  if (name.length > MAX_LENGTH) return { ok: false, rejection: 'too-long' };

  // ASCII only. A name is a URL segment, a cache key for a share image, and a
  // string somebody reads aloud; none of those want the whole of Unicode.
  if (!/^[a-z0-9_-]+$/.test(name)) return { ok: false, rejection: 'bad-characters' };

  // Must start with a letter and end alphanumeric, with no doubled separator.
  // Each of those shapes reads as a typo or as an attempt to sort next to an
  // existing name in a list.
  if (!/^[a-z]/.test(name)) return { ok: false, rejection: 'bad-shape' };
  if (!/[a-z0-9]$/.test(name)) return { ok: false, rejection: 'bad-shape' };
  if (/[_-]{2}/.test(name)) return { ok: false, rejection: 'bad-shape' };

  const folded = fold(name);
  if (RESERVED.has(name) || RESERVED.has(folded) || RESERVED_SKELETONS.has(skeleton(name))) {
    return { ok: false, rejection: 'reserved' };
  }
  if (isTaken(folded)) return { ok: false, rejection: 'taken' };

  return { ok: true, name };
}

/**
 * How many two-word combinations exist before the numeric suffix.
 *
 * Exported so a test fails loudly if the word lists ever shrink to the point
 * where collisions stop being rare.
 */
export const COMBINATIONS = ADJECTIVES.length * NOUNS.length;

/**
 * Draw an assigned name: `adjective-noun-nnnn`.
 *
 * The suffix is what makes this work at scale — two words alone collide by the
 * birthday bound after a few dozen participants, and retrying into a shrinking
 * pool gets slow long before it gets full.
 *
 * `random` returns a float in [0, 1). Injected rather than reaching for
 * `Math.random` so callers can supply a CSPRNG: an assigned name predictable
 * from the time of signup is a way to find a specific person's profile before
 * they have shared it.
 *
 * Returns `null` after `attempts` collisions rather than looping forever.
 */
export function assignName(
  isTaken: (folded: string) => boolean,
  random: () => number,
  attempts = 12,
): string | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const adjective = pick(ADJECTIVES, random);
    const noun = pick(NOUNS, random);
    const suffix = String(Math.floor(random() * 10_000)).padStart(4, '0');
    const name = `${adjective}-${noun}-${suffix}`;

    const folded = fold(name);
    if (RESERVED.has(folded) || RESERVED_SKELETONS.has(skeleton(name))) continue;
    if (!isTaken(folded)) return name;
  }

  return null;
}

function pick(list: readonly string[], random: () => number): string {
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index] ?? list[0] ?? 'wick';
}

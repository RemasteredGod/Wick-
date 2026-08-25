/**
 * Connect codes.
 *
 * ADR 0003: eight characters, an unambiguous alphabet, ten minutes, single use,
 * and destroyed after five failed attempts. That last rule is the one doing the
 * real work — it makes the size of the search space irrelevant, because nobody
 * gets to search it. The alphabet is about the user reading a code off a phone
 * and typing it into a browser, not about entropy.
 *
 * Pure. Randomness is injected so tests are deterministic and the caller
 * chooses the source — a code guessable from the time it was minted would
 * defeat the attempt limit entirely.
 */

/**
 * The alphabet, with every confusable pair removed.
 *
 * No `0`/`O`, no `1`/`I`/`L`. Someone reading a code off a phone screen and
 * typing it into another device should never have to decide which one they are
 * looking at, because a wrong guess spends one of their five attempts.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const CODE_LENGTH = 8;

/** Ten minutes, as ADR 0003 specifies. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Attempts before a code is destroyed rather than merely refused. */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Draw a code.
 *
 * `random` returns a float in [0, 1). Pass a CSPRNG in production; `Math.random`
 * is seeded from the clock in some engines, which is exactly the predictability
 * the attempt limit exists to make irrelevant — no reason to hand it back.
 */
export function mintCode(random: () => number): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const at = Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length));
    code += CODE_ALPHABET[at] ?? CODE_ALPHABET[0];
  }
  return code;
}

/**
 * Normalise what a user typed.
 *
 * Uppercased, and spaces stripped — people paste codes with a trailing space
 * and type them in lower case. Confusables are deliberately *not* mapped back:
 * they are not in the alphabet, so a code containing one was mistyped, and
 * silently repairing it would hide that from the user.
 */
export function normaliseCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/** Whether a string could be a code at all. Cheap check before touching storage. */
export function isCodeShape(input: string): boolean {
  if (input.length !== CODE_LENGTH) return false;
  for (const character of input) {
    if (!CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/** Whether a code minted at `mintedAt` is still live at `now`. */
export function isCodeLive(mintedAt: number, now: number): boolean {
  return now - mintedAt < CODE_TTL_MS;
}

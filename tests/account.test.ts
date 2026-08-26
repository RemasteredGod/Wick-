/**
 * The account identifier.
 *
 * This is the board's whole identity model, so the tests that matter are about
 * two things: not merging two accounts into one profile, and not splitting one
 * account across two. The first is unrecoverable, so the validator is allowed to
 * be loose and the normaliser is deliberately conservative.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EMAIL_LENGTH,
  isAccountEmail,
  normaliseAccountEmail,
  readAccountEmail,
} from '../leaderboard/account';

describe('reading an account', () => {
  it('accepts an ordinary address', () => {
    expect(readAccountEmail('apadhi6638@gmail.com')).toBe('apadhi6638@gmail.com');
  });

  it('accepts the shapes a strict grammar would wrongly refuse', () => {
    // Rejecting somebody's real address locks them out of the board. Every one
    // of these is deliverable mail.
    for (const email of [
      'ash-p@example.com',
      'ash+wick@example.co.uk',
      'ash_p@sub.domain.example.com',
      "o'brien@example.com",
      'ash.p@example.museum',
      'a@b.co',
    ]) {
      expect(readAccountEmail(email), email).toBe(email);
    }
  });

  it('refuses what cannot be a key', () => {
    for (const value of [
      '',
      'nobody',
      '@example.com',
      'ash@',
      'ash@example',
      'ash@@example.com',
      'ash@.example.com',
      'ash@example.com.',
      'ash@exa..mple.com',
      'ash example@x.com',
      null,
      42,
      undefined,
      {},
    ]) {
      expect(readAccountEmail(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses an invisible character rather than storing a key nobody can see', () => {
    // Two keys that render identically and compare unequal is exactly the split
    // this file exists to prevent, and a zero-width character is the way it
    // happens in practice.
    //
    // Built from code points rather than pasted. A test whose source contains
    // the invisible character it is testing for reads as a duplicate of the
    // line above it, and the next person to touch it cannot tell what changed.
    const invisible = [
      0x0009, // tab
      0x0020, // space
      0x200b, // zero-width space
      0x200d, // zero-width joiner
      0x2060, // word joiner
      0xfeff, // byte-order mark
    ];

    for (const code of invisible) {
      const email = `ash${String.fromCodePoint(code)}@example.com`;
      expect(readAccountEmail(email), `U+${code.toString(16).padStart(4, '0')}`).toBeNull();
    }
  });

  it('allows a hyphen, which an over-eager character class would eat', () => {
    expect(isAccountEmail('ash-p-q@my-domain.example.com')).toBe(true);
  });

  it('caps the length, so a body cannot make the primary key arbitrary', () => {
    const long = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`;
    expect(readAccountEmail(long)).toBeNull();
  });
});

describe('normalising', () => {
  it('folds case and surrounding space, so one account stays one profile', () => {
    // The sidebar rendering an address differently must not create a second
    // profile for the same person.
    expect(readAccountEmail('  Ash@Example.COM ')).toBe('ash@example.com');
    expect(normaliseAccountEmail('ASH@EXAMPLE.COM')).toBe('ash@example.com');
  });

  it('does not fold dots, which would merge two people at most providers', () => {
    // Gmail treats these as one mailbox; almost nobody else does. Merging two
    // accounts into one profile is unrecoverable, and letting one person hold
    // two is not.
    expect(readAccountEmail('a.b@example.com')).not.toBe(readAccountEmail('ab@example.com'));
  });

  it('does not strip a plus tag', () => {
    // Same argument. A provider that does not route tags would see two people.
    expect(readAccountEmail('ash+one@example.com')).not.toBe(
      readAccountEmail('ash@example.com'),
    );
  });

  it('is idempotent, or a stored key could stop matching itself', () => {
    const once = readAccountEmail('  Ash@Example.com ');
    expect(once).not.toBeNull();
    expect(readAccountEmail(once)).toBe(once);
  });
});

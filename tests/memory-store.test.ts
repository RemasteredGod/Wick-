/**
 * The in-memory `BoardStore`.
 *
 * It is a real implementation of the port rather than a stub, so it is worth
 * testing as one: the behaviour asserted here — upsert by day, unique names,
 * hard delete — is the contract every adapter has to keep, and a fake that
 * quietly diverges from it makes every test written against it a lie.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../server/memory-store';

const TODAY = '2026-08-25';

/** Sequential tokens, so a test can say which one it means. */
function store() {
  let issued = 0;
  return createMemoryStore(() => `tok-${String(++issued)}`);
}

describe('enrolling', () => {
  it('hands back a token and the name it assigned', async () => {
    const memory = store();
    expect(await memory.enroll(() => 'amber-ledger-0042')).toEqual({
      token: 'tok-1',
      name: 'amber-ledger-0042',
    });
  });

  it('refuses a name already held, on the folded form', async () => {
    // `ash`, `Ash` and `a5h` must not become three rows that read as one
    // person. Uniqueness is decided on the fold, never on the display name.
    const memory = store();
    await memory.enroll(() => 'ash');

    const names = ['Ash', 'a5h', 'free'];
    let index = 0;
    const second = await memory.enroll(() => names[index++] ?? 'fallback');

    expect(second?.name).toBe('free');
  });

  it('treats an underscore as a hyphen, not as nothing', async () => {
    // `fold` unifies the two separators with each other rather than stripping
    // them, so `as_h` folds to `as-h` and is a different name from `ash`. The
    // module docstring lists `as_h` among the variants of `ash`; the code does
    // not agree, and the code is what decides who gets a name.
    const memory = store();
    await memory.enroll(() => 'ash');

    expect(await memory.enroll(() => 'as_h')).toEqual({ token: 'tok-2', name: 'as_h' });
    // But the two separators do collide with each other.
    expect(await memory.enroll(() => 'as-h')).toBeNull();
  });

  it('gives up rather than looping forever on a full namespace', async () => {
    const memory = store();
    await memory.enroll(() => 'taken');
    expect(await memory.enroll(() => 'taken')).toBeNull();
  });

  it('gives each participant their own token', async () => {
    const memory = store();
    const first = await memory.enroll(() => 'one');
    const second = await memory.enroll(() => 'two');
    expect(first?.token).not.toBe(second?.token);
  });
});

describe('submitting', () => {
  it('replaces a day rather than adding to it', async () => {
    // A retried request must correct a total, not inflate one.
    const memory = store();
    const { token } = (await memory.enroll(() => 'ash')) ?? { token: '' };

    await memory.saveDaily(token, { day: TODAY, messages: 10 });
    await memory.saveDaily(token, { day: TODAY, messages: 25 });

    const standing = await memory.standing('ash', 'all', TODAY);
    expect(standing?.ranked).toBe(25);
    expect(standing?.days).toBe(1);
  });

  it('accumulates across distinct days', async () => {
    const memory = store();
    const { token } = (await memory.enroll(() => 'ash')) ?? { token: '' };

    await memory.saveDaily(token, { day: '2026-08-24', messages: 10 });
    await memory.saveDaily(token, { day: TODAY, messages: 25 });

    const standing = await memory.standing('ash', 'all', TODAY);
    expect(standing?.ranked).toBe(35);
    expect(standing?.days).toBe(2);
  });

  it('drops a write from a token nobody holds', async () => {
    // An unknown token must not conjure a participant into existence.
    const memory = store();
    await memory.saveDaily('nobody', { day: TODAY, messages: 99 });
    expect(await memory.board('all', TODAY, 10)).toEqual([]);
  });
});

describe('profiles', () => {
  it('reads a profile by token, and nothing by a wrong one', async () => {
    const memory = store();
    const { token } = (await memory.enroll(() => 'ash')) ?? { token: '' };

    expect(await memory.profile(token)).toEqual({ name: 'ash' });
    expect(await memory.profile('wrong')).toBeNull();
  });
});

describe('leaving', () => {
  it('takes the rows with the profile', async () => {
    const memory = store();
    const { token } = (await memory.enroll(() => 'ash')) ?? { token: '' };
    await memory.saveDaily(token, { day: TODAY, messages: 10 });

    await memory.forget(token);

    expect(await memory.profile(token)).toBeNull();
    expect(await memory.board('all', TODAY, 10)).toEqual([]);
    expect(await memory.standing('ash', 'all', TODAY)).toBeNull();
  });

  it('returns the name to the pool', async () => {
    const memory = store();
    const first = (await memory.enroll(() => 'ash')) ?? { token: '' };
    await memory.forget(first.token);

    expect(await memory.enroll(() => 'ash')).toEqual({ token: 'tok-2', name: 'ash' });
  });

  it('leaves everyone else alone', async () => {
    const memory = store();
    const leaver = (await memory.enroll(() => 'leaver')) ?? { token: '' };
    const stayer = (await memory.enroll(() => 'stayer')) ?? { token: '' };
    await memory.saveDaily(leaver.token, { day: TODAY, messages: 10 });
    await memory.saveDaily(stayer.token, { day: TODAY, messages: 20 });

    await memory.forget(leaver.token);

    const board = await memory.board('all', TODAY, 10);
    expect(board.map((standing) => standing.name)).toEqual(['stayer']);
  });
});

describe('seeding', () => {
  it('puts a participant straight onto the board', async () => {
    const memory = store();
    memory.seed('seeded', 'ash', [{ day: TODAY, messages: 40 }]);

    const board = await memory.board('all', TODAY, 10);
    expect(board[0]?.name).toBe('ash');
    expect(board[0]?.ranked).toBe(40);
  });
});

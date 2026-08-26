/**
 * The in-memory `BoardStore`.
 *
 * It is a real implementation of the port rather than a stub, so it is worth
 * testing as one: the behaviour asserted here — one profile per account across
 * browsers, upsert by day, hard delete — is the contract every adapter has to
 * keep, and a fake that quietly diverges from it makes every test written
 * against it a lie.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../server/memory-store';

const TODAY = '2026-08-25';
const ASH = 'ash@example.com';
const OTHER = 'someone-else@example.com';

/** Sequential tokens, so a test can say which one it means. */
function store() {
  let issued = 0;
  return createMemoryStore(() => `tok-${String(++issued)}`);
}

describe('enrolling', () => {
  it('hands back a token and the name it assigned', async () => {
    const memory = store();
    expect(await memory.enroll(ASH, () => 'amber-ledger-0042')).toEqual({
      token: 'tok-1',
      name: 'amber-ledger-0042',
      existing: false,
    });
  });

  it('gives a second browser on one account the same profile', async () => {
    // The whole point of keying on the account: one Claude account is one
    // public profile, however many browsers sign into it, with no link step.
    const memory = store();
    const first = await memory.enroll(ASH, () => 'amber-ledger-0042');
    const second = await memory.enroll(ASH, () => 'a-completely-different-name');

    expect(second?.name).toBe('amber-ledger-0042');
    expect(second?.existing).toBe(true);
    // A distinct token, so each browser holds its own credential.
    expect(second?.token).not.toBe(first?.token);
  });

  it('never creates a second profile for one account', async () => {
    const memory = store();
    for (let index = 0; index < 5; index += 1) {
      await memory.enroll(ASH, () => `name-${String(index)}`);
    }
    // One name holds the account, and it is the first one assigned.
    expect((await memory.enroll(ASH, () => 'late'))?.name).toBe('name-0');
  });

  it('gives a different account its own profile', async () => {
    const memory = store();
    const mine = await memory.enroll(ASH, () => 'mine');
    const theirs = await memory.enroll(OTHER, () => 'theirs');

    expect(theirs?.name).toBe('theirs');
    expect(theirs?.token).not.toBe(mine?.token);
  });

  it('refuses a name already held, on the folded form', async () => {
    // `ash`, `Ash` and `a5h` must not become three rows that read as one
    // person. Uniqueness is decided on the fold, never on the display name.
    const memory = store();
    await memory.enroll(ASH, () => 'ash');

    const names = ['Ash', 'a5h', 'free'];
    let index = 0;
    const second = await memory.enroll(OTHER, () => names[index++] ?? 'fallback');

    expect(second?.name).toBe('free');
  });

  it('treats an underscore as a hyphen, not as nothing', async () => {
    // `fold` unifies the two separators with each other rather than stripping
    // them, so `as_h` folds to `as-h` and is a different name from `ash`. The
    // module docstring lists `as_h` among the variants of `ash`; the code does
    // not agree, and the code is what decides who gets a name.
    const memory = store();
    await memory.enroll(ASH, () => 'ash');

    expect((await memory.enroll(OTHER, () => 'as_h'))?.name).toBe('as_h');
    expect(await memory.enroll('third@example.com', () => 'as-h')).toBeNull();
  });

  it('gives up rather than looping forever on a full namespace', async () => {
    const memory = store();
    await memory.enroll(ASH, () => 'taken');
    expect(await memory.enroll(OTHER, () => 'taken')).toBeNull();
  });
});

describe('submitting', () => {
  it('replaces a day rather than adding to it', async () => {
    // A retried request must correct a total, not inflate one.
    const memory = store();
    const { token } = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };

    await memory.saveDaily(token, { day: TODAY, messages: 10 });
    await memory.saveDaily(token, { day: TODAY, messages: 25 });

    const stats = await memory.stats('ash', TODAY);
    expect(stats?.standings.get('all')?.ranked).toBe(25);
    expect(stats?.standings.get('all')?.days).toBe(1);
  });

  it('converges two browsers on one account onto one row', async () => {
    // Both are the same account, so the day must not be counted twice.
    const memory = store();
    const laptop = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    const desktop = (await memory.enroll(ASH, () => 'unused')) ?? { token: '' };

    await memory.saveDaily(laptop.token, { day: TODAY, messages: 12 });
    await memory.saveDaily(desktop.token, { day: TODAY, messages: 12 });

    const stats = await memory.stats('ash', TODAY);
    expect(stats?.standings.get('all')?.ranked).toBe(12);
    expect(stats?.standings.get('all')?.days).toBe(1);
  });

  it('accumulates across distinct days', async () => {
    const memory = store();
    const { token } = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };

    await memory.saveDaily(token, { day: '2026-08-24', messages: 10 });
    await memory.saveDaily(token, { day: TODAY, messages: 25 });

    const stats = await memory.stats('ash', TODAY);
    expect(stats?.standings.get('all')?.ranked).toBe(35);
    expect(stats?.standings.get('all')?.days).toBe(2);
    // Two consecutive days, so the streak is two.
    expect(stats?.streak).toBe(2);
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
    const { token } = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };

    expect(await memory.profile(token)).toEqual({ name: 'ash' });
    expect(await memory.profile('wrong')).toBeNull();
  });

  it('answers every browser token with the same profile', async () => {
    const memory = store();
    const laptop = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    const desktop = (await memory.enroll(ASH, () => 'unused')) ?? { token: '' };

    expect(await memory.profile(desktop.token)).toEqual(await memory.profile(laptop.token));
  });
});

describe('leaving', () => {
  it('takes the rows with the profile', async () => {
    const memory = store();
    const { token } = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    await memory.saveDaily(token, { day: TODAY, messages: 10 });

    await memory.forget(token);

    expect(await memory.profile(token)).toBeNull();
    expect(await memory.board('all', TODAY, 10)).toEqual([]);
    expect(await memory.stats('ash', TODAY)).toBeNull();
  });

  it('unbinds every browser, not just the one that asked', async () => {
    // Leave says the profile is gone. Unbinding one browser would leave the
    // public page up and the other still publishing to it.
    const memory = store();
    const laptop = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    const desktop = (await memory.enroll(ASH, () => 'unused')) ?? { token: '' };

    await memory.forget(laptop.token);

    expect(await memory.profile(desktop.token)).toBeNull();
    await memory.saveDaily(desktop.token, { day: TODAY, messages: 50 });
    expect(await memory.board('all', TODAY, 10)).toEqual([]);
  });

  it('returns the name and the account to the pool', async () => {
    const memory = store();
    const first = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    await memory.forget(first.token);

    expect(await memory.enroll(ASH, () => 'ash')).toEqual({
      token: 'tok-2',
      name: 'ash',
      existing: false,
    });
  });

  it('leaves everyone else alone', async () => {
    const memory = store();
    const leaver = (await memory.enroll(ASH, () => 'leaver')) ?? { token: '' };
    const stayer = (await memory.enroll(OTHER, () => 'stayer')) ?? { token: '' };
    await memory.saveDaily(leaver.token, { day: TODAY, messages: 10 });
    await memory.saveDaily(stayer.token, { day: TODAY, messages: 20 });

    await memory.forget(leaver.token);

    const board = await memory.board('all', TODAY, 10);
    expect(board.map((standing) => standing.name)).toEqual(['stayer']);
  });
});

describe('profile stats', () => {
  it('answers every period and the streak from one call', async () => {
    const memory = store();
    const { token } = (await memory.enroll(ASH, () => 'ash')) ?? { token: '' };
    await memory.saveDaily(token, { day: '2026-08-23', messages: 4 });
    await memory.saveDaily(token, { day: '2026-08-24', messages: 6 });
    await memory.saveDaily(token, { day: TODAY, messages: 5 });

    const stats = await memory.stats('ash', TODAY);
    expect([...(stats?.standings.keys() ?? [])]).toEqual(['week', 'month', 'all']);
    expect(stats?.standings.get('all')?.ranked).toBe(15);
    expect(stats?.streak).toBe(3);
  });

  it('hides a joined participant who has published nothing', async () => {
    // Indistinguishable from a name nobody has taken, and from one whose holder
    // left. A page that separated them would let anyone enumerate who had quit.
    const memory = store();
    await memory.enroll(ASH, () => 'silent');

    expect(await memory.stats('silent', TODAY)).toBeNull();
    expect(await memory.stats('never-existed', TODAY)).toBeNull();
  });

  it('ranks against everyone, not against the published slice', async () => {
    const memory = store();
    for (let index = 0; index < 120; index += 1) {
      const name = `p${String(index).padStart(3, '0')}`;
      const enrolment = await memory.enroll(`${name}@example.com`, () => name);
      await memory.saveDaily(enrolment?.token ?? '', { day: TODAY, messages: 1_000 - index });
    }

    const stats = await memory.stats('p110', TODAY);
    expect(stats?.standings.get('all')?.rank).toBe(111);
    expect((await memory.board('all', TODAY, 100)).some((s) => s.name === 'p110')).toBe(false);
  });
});

describe('seeding', () => {
  it('puts a participant straight onto the board', async () => {
    const memory = store();
    memory.seed(ASH, 'seeded', 'ash', [{ day: TODAY, messages: 40 }]);

    const board = await memory.board('all', TODAY, 10);
    expect(board[0]?.name).toBe('ash');
    expect(board[0]?.ranked).toBe(40);
  });
});

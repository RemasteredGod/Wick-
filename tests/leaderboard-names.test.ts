import { describe, expect, it } from 'vitest';
import {
  assignName,
  COMBINATIONS,
  fold,
  MAX_LENGTH,
  RESERVED,
  skeleton,
  validateName,
} from '../leaderboard/names';
import {
  buildCard,
  nameFromPath,
  profilePath,
  shareImagePath,
  SELF_REPORTED_LABEL,
} from '../leaderboard/profile';
import type { Period } from '../leaderboard/periods';
import type { Standing } from '../leaderboard/ranking';

const free = () => false;

/** A deterministic stand-in for the injected CSPRNG. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('name folding', () => {
  it('collapses the variants that read as one name on a page', () => {
    const canonical = fold('ash');
    expect(fold('ASH')).toBe(canonical);
    expect(fold('a5h')).toBe(canonical);
    expect(fold('a​sh')).toBe(canonical);
    expect(fold('ａｓｈ')).toBe(canonical); // fullwidth
  });

  it('folds hyphen and underscore together', () => {
    expect(fold('two_words')).toBe(fold('two-words'));
  });

  it('folds letter-shaped digits', () => {
    expect(fold('l33t')).toBe(fold('leet'));
    expect(fold('r00t')).toBe(fold('root'));
  });
});

describe('skeleton', () => {
  it('is used only for the reserved list, and stays blunt on purpose', () => {
    expect(skeleton('adm1n')).toBe(skeleton('admin'));
    expect(skeleton('a-d-m-i-n')).toBe(skeleton('admin'));
  });

  it('over-matches in a way fold deliberately does not', () => {
    // Documented cost: these collide under skeleton but must stay distinct
    // between users, which is why fold is what the taken check uses.
    expect(skeleton('silt')).toBe(skeleton('slit'));
    expect(fold('silt')).not.toBe(fold('slit'));
  });
});

describe('validateName', () => {
  it('accepts an ordinary name', () => {
    expect(validateName('ashutosh', free)).toEqual({ ok: true, name: 'ashutosh' });
    expect(validateName('  Ash-Padhi  ', free)).toEqual({ ok: true, name: 'ash-padhi' });
  });

  it('enforces length', () => {
    expect(validateName('ab', free)).toEqual({ ok: false, rejection: 'too-short' });
    expect(validateName('a'.repeat(MAX_LENGTH + 1), free)).toEqual({
      ok: false,
      rejection: 'too-long',
    });
  });

  it('refuses non-ASCII and punctuation', () => {
    for (const bad of ['ash!', 'ash padhi', 'ashū', 'ash.padhi', 'ash/padhi']) {
      expect(validateName(bad, free), bad).toEqual({ ok: false, rejection: 'bad-characters' });
    }
  });

  it('refuses shapes that read as typos or sort-order games', () => {
    for (const bad of ['1ash', '-ash', 'ash-', 'ash_', 'a--b', 'a__b']) {
      expect(validateName(bad, free), bad).toEqual({ ok: false, rejection: 'bad-shape' });
    }
  });

  it('refuses reserved names, including route segments', () => {
    for (const bad of ['admin', 'anthropic', 'claude', 'wick', 'api', 'support', 'profile']) {
      expect(validateName(bad, free), bad).toEqual({ ok: false, rejection: 'reserved' });
    }
  });

  it('refuses short reserved names too, even though length rejects them first', () => {
    // `u` and `mod` are reserved but below or near MIN_LENGTH. What matters is
    // that neither can be held, not which rule turned it away.
    for (const bad of ['u', 'v1', 'mod']) {
      expect(validateName(bad, free).ok, bad).toBe(false);
    }
  });

  it('refuses a reserved name spelled with confusables', () => {
    // The whole point of folding: paying a dollar to be `4dmin`-adjacent should
    // not work either.
    for (const spoof of ['adm1n', 'admln', 'anthr0pic', 'w1ck', 'supp0rt', 'a-d-m-i-n']) {
      expect(validateName(spoof, free), spoof).toEqual({ ok: false, rejection: 'reserved' });
    }
  });

  it('refuses a name that folds onto a taken one', () => {
    const taken = new Set([fold('ash')]);
    const isTaken = (folded: string) => taken.has(folded);

    expect(validateName('ash', isTaken)).toEqual({ ok: false, rejection: 'taken' });
    expect(validateName('a5h', isTaken)).toEqual({ ok: false, rejection: 'taken' });
    expect(validateName('ASH', isTaken)).toEqual({ ok: false, rejection: 'taken' });
    expect(validateName('asher', isTaken).ok).toBe(true);
  });

  it('asks the uniqueness index in folded form', () => {
    const seen: string[] = [];
    validateName('Ash_Padhi', (folded) => {
      seen.push(folded);
      return false;
    });
    expect(seen).toEqual(['ash-padhi']);
  });
});

describe('assignName', () => {
  it('produces adjective-noun-nnnn', () => {
    const name = assignName(free, sequence([0, 0, 0.4242]));
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  });

  it('pads the suffix so every assigned name is the same shape', () => {
    const name = assignName(free, sequence([0, 0, 0]));
    expect(name?.endsWith('-0000')).toBe(true);
  });

  it('retries past a collision', () => {
    let calls = 0;
    const isTaken = () => {
      calls += 1;
      return calls === 1; // first draw is taken, second is free
    };

    expect(assignName(isTaken, sequence([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]))).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('gives up rather than looping forever when everything is taken', () => {
    expect(assignName(() => true, sequence([0.5]), 5)).toBeNull();
  });

  it('never draws a name that would be refused as a rename', () => {
    // An assigned name a user could not have bought would be an odd thing to
    // hand them, and a route-shadowing one would break the site.
    const random = sequence([0.13, 0.77, 0.91, 0.02, 0.44, 0.68, 0.35, 0.59]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const name = assignName(free, random);
      expect(name).not.toBeNull();
      if (name === null) break;
      expect(RESERVED.has(fold(name))).toBe(false);
      expect(validateName(name, free).ok, name).toBe(true);
    }
  });

  it('keeps a large enough pool that collisions stay rare', () => {
    expect(COMBINATIONS).toBeGreaterThanOrEqual(2_000);
  });

  it('does not derive anything from a Telegram identity', () => {
    // There is no parameter through which one could. Guarded as a signature
    // test because ADR 0007 turns on it.
    expect(assignName.length).toBeLessThanOrEqual(3);
  });
});

describe('profile addresses', () => {
  it('uses /u/<name>, not /profile=<name>', () => {
    expect(profilePath('ash')).toBe('/u/ash');
    expect(profilePath('ash')).not.toContain('=');
    expect(shareImagePath('ash')).toBe('/u/ash/card.png');
  });

  it('reads a name back out of a path', () => {
    expect(nameFromPath('/u/ash')).toBe('ash');
    expect(nameFromPath('/u/amber-ledger-0042')).toBe('amber-ledger-0042');
  });

  it('refuses paths that are not a profile', () => {
    expect(nameFromPath('/u/')).toBeNull();
    expect(nameFromPath('/ash')).toBeNull();
    expect(nameFromPath('/u/ash/card.png')).toBeNull();
    expect(nameFromPath('/u/%E0%A4%A')).toBeNull();
  });
});

describe('profile card', () => {
  function standing(rank: number, ranked: number): Standing {
    return { rank, name: 'ash', ranked, days: 7, lastDay: '2026-08-25' };
  }

  it('always carries the self-reported label', () => {
    const card = buildCard('ash', new Map<Period, Standing | null>([['all', standing(3, 30)]]), 4);
    expect(card.label).toBe(SELF_REPORTED_LABEL);
  });

  it('omits a period with no standing rather than showing rank zero', () => {
    const card = buildCard(
      'ash',
      new Map<Period, Standing | null>([
        ['week', null],
        ['month', standing(9, 30)],
        ['all', standing(3, 30)],
      ]),
      4,
    );

    expect(card.standings.map((line) => line.period)).toEqual(['month', 'all']);
  });

  it('takes its totals from the all-time standing, not from a period', () => {
    const card = buildCard(
      'ash',
      new Map<Period, Standing | null>([
        ['week', standing(1, 5)],
        ['all', standing(3, 30)],
      ]),
      4,
    );
    // The card's headline figures describe the whole record; the per-period
    // ranks are the table beneath it.
    expect(card.messages).toBe(30);
    expect(card.days).toBe(7);
    expect(card.standings.map((line) => line.ranked)).toEqual([5, 30]);
  });

  it('shows no plan tier, no social graph, and no times of day', () => {
    const card = buildCard('ash', new Map<Period, Standing | null>([['all', standing(1, 30)]]), 4);
    const keys = Object.keys(card);
    for (const forbidden of ['plan', 'tier', 'friends', 'followers', 'hourly', 'utilization']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });
});

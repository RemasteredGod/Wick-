import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderBoard,
  renderLanding,
  renderMissingProfile,
  renderProfile,
} from '../leaderboard/render';
import { SELF_REPORTED_LABEL, buildCard } from '../leaderboard/profile';
import type { Period } from '../leaderboard/periods';
import type { Standing } from '../leaderboard/ranking';

const TODAY = '2026-08-25';

function standing(over: Partial<Standing> = {}): Standing {
  return { rank: 1, name: 'amber-ledger-0042', ranked: 12_000, days: 19, lastDay: TODAY, ...over };
}

function board(standings: Standing[], period: 'week' | 'month' | 'all' = 'week') {
  return renderBoard({ period, standings, today: TODAY });
}

/**
 * The visible copy of a page, lowercased.
 *
 * For asserting that a word does *not* appear. Matching against the whole
 * document catches the stylesheet — `text-align:left` and `padding-left` both
 * contain "left" — and turns "the page never says it was deleted" into a test
 * of the CSS. Strip the head and the tags first, then the assertion means what
 * it reads as.
 */
function copy(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase();
}

describe('escaping', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escapeHtml(`" & '`)).toBe('&quot; &amp; &#39;');
  });

  it('escapes a name even though the validator should have stopped it', () => {
    // The validator and this renderer are separated by a database and a
    // deployment. "Should" is not worth betting a stored-XSS on.
    const html = board([standing({ name: '<img src=x onerror=alert(1)>' })]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('the board', () => {
  it('carries the self-reported label', () => {
    // Required on the page itself by ADR 0006 — the v2 artboard omitted it.
    const html = board([standing()]);
    expect(html).toContain(SELF_REPORTED_LABEL);
  });

  it('renders the score and the days behind it', () => {
    const html = board([standing()]);
    expect(html).toContain('12,000'); // messages, the ranked figure
    expect(html).toContain('19'); // days
  });

  it('shows no plan tier, no social graph, and no percentage of a limit', () => {
    // Each was drawn in the v2 archive and each is a personal field with no
    // route into the schema. Adding one is an ADR, not a column.
    const text = copy(board([standing()]));
    for (const forbidden of ['plan', 'max 20', 'friends', 'followers', 'utilization', '%']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('ships no client script and no external asset', () => {
    const html = board([standing()]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('http://');
    // The only outbound links are the project's own.
    expect(html.match(/https:\/\/(?!github\.com\/RemasteredGod)/)).toBeNull();
  });

  it('makes the period switcher three real links', () => {
    // No client state to hold, and three URLs can be shared and cached.
    const html = board([standing()], 'month');
    expect(html).toContain('href="/board"');
    expect(html).toContain('href="/board?p=month"');
    expect(html).toContain('href="/board?p=all"');
  });

  it('marks the active period', () => {
    expect(board([standing()], 'all')).toContain('href="/board?p=all" class="on"');
  });

  it('says the board is empty rather than rendering a bare table', () => {
    const html = board([]);
    expect(html).toContain('No submissions');
    expect(html).not.toContain('<tbody>');
  });

  it('sizes bars against the leader, not against a limit', () => {
    const html = board([
      standing({ rank: 1, name: 'first', ranked: 1_000 }),
      standing({ rank: 2, name: 'second', ranked: 250 }),
    ]);
    expect(html).toContain('width:100%');
    expect(html).toContain('width:25%');
  });

  it('gives a zero-width bar a visible minimum', () => {
    // A row on the board did real work; rendering it as nothing reads as a bug.
    const html = board([
      standing({ rank: 1, name: 'first', ranked: 100_000 }),
      standing({ rank: 2, name: 'second', ranked: 1 }),
    ]);
    expect(html).toContain('width:1%');
    expect(html).not.toContain('width:0%');
  });

  it('marks only the leading row', () => {
    const html = board([
      standing({ rank: 1, name: 'first' }),
      standing({ rank: 2, name: 'second' }),
      standing({ rank: 3, name: 'third' }),
    ]);
    expect(html.match(/<tr class="lead"/g)).toHaveLength(1);
  });

  it('reads recent days as relative and older ones as dates', () => {
    expect(board([standing({ lastDay: TODAY })])).toContain('today');
    expect(board([standing({ lastDay: '2026-08-24' })])).toContain('yesterday');
    expect(board([standing({ lastDay: '2026-08-22' })])).toContain('3d ago');
    expect(board([standing({ lastDay: '2026-01-01' })])).toContain('2026-01-01');
    expect(board([standing({ lastDay: null })])).toContain('—');
  });

  it('groups thousands so columns of digits stay readable', () => {
    expect(board([standing({ ranked: 1_234_567 })])).toContain('1,234,567');
  });
});

describe('the landing page', () => {
  it('links to the board and the source, and ships no script', () => {
    const html = renderLanding();
    expect(html).toContain('href="/board"');
    expect(html).toContain('github.com/RemasteredGod/Wick-');
    expect(html).not.toContain('<script');
  });

  it('describes alerts as needing no setup', () => {
    expect(renderLanding()).toContain('no setup');
  });

  it('no longer offers Telegram anywhere', () => {
    const html = renderLanding().toLowerCase();
    expect(html).not.toContain('telegram');
    expect(html).not.toContain('botfather');
  });

  it('says the leaderboard is opt-in and separate', () => {
    expect(renderLanding().toLowerCase()).toContain('opt-in leaderboard');
  });
});

/* ---- profiles ------------------------------------------------------------- */

describe('a profile page', () => {
  function card(over: Partial<Standing> = {}) {
    return buildCard(
      'amber-ledger-0042',
      new Map<Period, Standing | null>([
        ['week', standing({ rank: 4, ranked: 300, days: 5, ...over })],
        ['all', standing({ rank: 2, ranked: 12_000, days: 19, ...over })],
      ]),
      5,
    );
  }

  it('carries the self-reported label', () => {
    expect(renderProfile(card(), TODAY)).toContain(SELF_REPORTED_LABEL);
  });

  it('shows a rank per period and the all-time totals', () => {
    const html = renderProfile(card(), TODAY);
    expect(html).toContain('#4');
    expect(html).toContain('#2');
    expect(html).toContain('12,000');
    expect(html).toContain('amber-ledger-0042');
  });

  it('links back to the board and ships no script', () => {
    const html = renderProfile(card(), TODAY);
    expect(html).toContain('href="/board"');
    expect(html).not.toContain('<script');
  });

  it('escapes a name even though the validator should have stopped it', () => {
    const html = renderProfile(
      buildCard(
        '<img src=x onerror=alert(1)>',
        new Map<Period, Standing | null>([['all', standing()]]),
        0,
      ),
      TODAY,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('says nothing about which model, project or time of day', () => {
    const text = copy(renderProfile(card(), TODAY));
    for (const forbidden of ['opus', 'sonnet', 'peak hr', 'utilization', '%']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('does not distinguish a name that never existed from one that left', () => {
    // A page that told you which would let anyone enumerate who had quit.
    const html = renderMissingProfile();
    expect(html).toContain('No such profile');

    const text = copy(html);
    for (const forbidden of ['left', 'deleted', 'removed', 'quit']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

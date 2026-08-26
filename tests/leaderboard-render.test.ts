import { describe, expect, it } from 'vitest';
import { escapeHtml, renderBoard, renderLanding } from '../leaderboard/render';
import { SELF_REPORTED_LABEL } from '../leaderboard/profile';
import type { Standing } from '../leaderboard/ranking';

const TODAY = '2026-08-25';

function standing(over: Partial<Standing> = {}): Standing {
  return {
    rank: 1,
    name: 'amber-ledger-0042',
    ranked: 12_000,
    counters: { input: 5_000, output: 7_000, cacheCreation: 900, cacheRead: 4_000_000 },
    sessions: 19,
    lastDay: TODAY,
    ...over,
  };
}

function board(standings: Standing[], period: 'week' | 'month' | 'all' = 'week') {
  return renderBoard({ period, standings, today: TODAY });
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

  it('renders the figures ADR 0006 lists', () => {
    const html = board([standing()]);
    expect(html).toContain('7,000'); // output
    expect(html).toContain('5,000'); // input
    expect(html).toContain('4,000,000'); // cache reads, shown
    expect(html).toContain('19'); // sessions
  });

  it('shows no plan tier, message count, or social graph', () => {
    // Each was drawn in the v2 archive and each is a personal field with no
    // route into the schema. Adding one is an ADR, not a column.
    const html = board([standing()]).toLowerCase();
    for (const forbidden of ['plan', 'max 20', 'messages', 'friends', 'followers']) {
      expect(html, forbidden).not.toContain(forbidden);
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
    expect(board([standing({ counters: { input: 1_234_567, output: 1, cacheCreation: 0, cacheRead: 0 } })]))
      .toContain('1,234,567');
  });
});

describe('the landing page', () => {
  it('links to the board and the source, and ships no script', () => {
    const html = renderLanding();
    expect(html).toContain('href="/board"');
    expect(html).toContain('github.com/RemasteredGod/Wick-');
    expect(html).not.toContain('<script');
  });

  it('describes alerts as needing no server', () => {
    expect(renderLanding()).toContain('straight from your browser');
  });

  it('says the leaderboard is opt-in and separate', () => {
    expect(renderLanding().toLowerCase()).toContain('opt-in leaderboard');
  });
});

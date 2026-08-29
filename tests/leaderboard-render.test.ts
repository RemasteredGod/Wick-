import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import BRAND_IDENTITY from '../brand/v3/geometry.json' with { type: 'json' };

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
import { sendHtml } from '../server/http';
import { response } from './helpers/http';

const TODAY = '2026-08-25';

function standing(over: Partial<Standing> = {}): Standing {
  return { rank: 1, name: 'amber-ledger-0042', ranked: 12_000, days: 19, lastDay: TODAY, ...over };
}

function board(standings: Standing[], period: 'week' | 'month' | 'all' = 'week') {
  return renderBoard({ period, standings, today: TODAY });
}

/**
 * The page's markup with the stylesheet removed.
 *
 * For asserting that a class is *absent*. Every class the pages use also
 * appears in the one inline `<style>` as a selector, so matching the whole
 * document turns "this row is not rendered" into "this rule is not defined" —
 * which is never what the test means.
 */
function markup(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, ' ');
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

/** Normalize CSS hex/rgb/rgba spellings to an alpha-independent RGB key. */
function colourKey(value: string): string | null {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const rgb =
      hex.length <= 4
        ? [...hex.slice(0, 3)].map((digit) => digit + digit)
        : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return rgb.map((channel) => Number.parseInt(channel, 16)).join(',');
  }

  const body = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'));
  const channels = (body.split('/')[0] ?? '')
    .trim()
    .split(/[,\s]+/u)
    .filter(Boolean)
    .slice(0, 3);
  if (channels.length !== 3) return null;
  const numbers = channels.map((channel) => Number(channel));
  if (numbers.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }
  return numbers.join(',');
}

function sourceColourKeys(source: string): string[] {
  return [...source.matchAll(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/giu)]
    .map((match) => colourKey(match[0] ?? ''))
    .filter((key): key is string => key !== null);
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

  it('ships no client script or external asset and only approved outbound links', () => {
    const html = board([standing()]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('http://');

    const outbound = [...markup(html).matchAll(/href="(https:\/\/[^\"]+)"/g)].map(
      (match) => match[1],
    );
    expect(outbound).toEqual([
      'https://ko-fi.com/remasteredgod',
      'https://github.com/RemasteredGod/Wick-',
    ]);
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
    const html = markup(board([]));
    expect(html).toContain('No submissions');
    expect(html).not.toContain('class="row lead"');
    expect(html).not.toContain('row--head');
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

  it('renders exactly one static sponsor link with no-referrer protection', () => {
    const html = board([standing()]);
    const sponsorUrl = 'https://ko-fi.com/remasteredgod';

    expect(html.match(new RegExp(sponsorUrl.replace(/[./-]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(html).toContain(
      `<a class="button" href="${sponsorUrl}" target="_blank" rel="noreferrer" referrerpolicy="no-referrer">Sponsor this project</a>`,
    );
    expect(html).not.toContain(`${sponsorUrl}?`);
    expect(html).not.toContain('<img');
  });

  it('keeps the sponsor rail out of content flow and hides it at constrained widths', () => {
    const html = board([standing()]);

    expect(html).toContain('.sponsor{position:fixed');
    expect(html).toContain('@media(max-width:1240px){.sponsor{display:none}}');
  });

  it('preserves the page-level no-referrer response policy', () => {
    const sent = response();
    sendHtml(sent.res, 200, board([standing()]), 'public, max-age=60');

    expect(sent.headers['referrer-policy']).toBe('no-referrer');
    expect(sent.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });

  it('marks only the leading row', () => {
    // The rows are a CSS grid rather than a table now — the canvas lays them
    // out that way so the share bar can be a real element instead of a cell.
    // What is asserted is unchanged: exactly one row is the leader.
    const html = markup(
      board([
        standing({ rank: 1, name: 'first' }),
        standing({ rank: 2, name: 'second' }),
        standing({ rank: 3, name: 'third' }),
      ]),
    );
    expect(html.match(/class="row lead"/g)).toHaveLength(1);
  });

  it('ships the motion as CSS, so the CSP does not have to widen', () => {
    // `server/http.ts` sends `default-src 'none'; style-src 'unsafe-inline'`.
    // One <script> anywhere on these pages would mean widening that for the
    // whole site, which is a much larger change than any animation is worth.
    const html = board([standing()]);
    expect(html).not.toContain('<script');
    for (const frames of ['wRise', 'wFade', 'wBar', 'wFlicker']) {
      expect(html, frames).toContain(`@keyframes ${frames}`);
    }
  });

  it('respects prefers-reduced-motion by removing the motion, not shortening it', () => {
    // Every entrance starts at opacity:0. A faster version would still be
    // movement, and would still leave a reader who asked for none watching
    // things arrive.
    const html = board([standing()]);
    expect(html).toContain('@media(prefers-reduced-motion:reduce)');
    expect(html).toContain('animation:none!important');
  });

  it('staggers rows without letting a long board crawl', () => {
    // 45ms apart, capped: past a couple of dozen rows the stagger has made its
    // point and everything below the fold should be there on arrival.
    const many = Array.from({ length: 60 }, (_, index) =>
      standing({ rank: index + 1, name: `p${String(index)}`, ranked: 1_000 - index }),
    );
    const delays = [...board(many).matchAll(/animation-delay:([\d.]+)s/g)].map((m) =>
      Number(m[1]),
    );
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1.1);
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

describe('site identity', () => {
  const pages = [renderLanding(), board([standing()]), renderMissingProfile()];
  const identityKeys = new Set(
    [
      BRAND_IDENTITY.gradient.start,
      BRAND_IDENTITY.gradient.end,
      ...Object.values(BRAND_IDENTITY.colours),
    ]
      .map(colourKey)
      .filter((key): key is string => key !== null),
  );

  function equivalentSpellings(hex: string): string[] {
    const key = colourKey(hex);
    if (key === null) return [];
    const [red, green, blue] = key.split(',');
    return [
      hex,
      hex.toUpperCase(),
      `rgb(${red}, ${green}, ${blue})`,
      `rgb(${red} ${green} ${blue})`,
      `rgba(${red},${green},${blue},.045)`,
      `rgba(${red} ${green} ${blue} / .045)`,
    ];
  }

  it.each(equivalentSpellings(BRAND_IDENTITY.gradient.start))(
    'recognises an equivalent derived identity colour spelling: %s',
    (spelling) => {
      expect(identityKeys).toContain(colourKey(spelling));
    },
  );

  it('keeps raw identity colour equivalents out of renderer and test sources', () => {
    const sources = [
      readFileSync(new URL('../leaderboard/render.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./leaderboard-render.test.ts', import.meta.url), 'utf8'),
    ];
    const duplicates = sources.flatMap(sourceColourKeys).filter((key) => identityKeys.has(key));
    expect(duplicates).toEqual([]);
  });

  it('allows the unchanged lead tint when it is generated from shared identity data', () => {
    const start = colourKey(BRAND_IDENTITY.gradient.start);
    expect(start).not.toBeNull();
    expect(board([standing()])).toContain(`.row.lead{background:rgba(${String(start)},.045)}`);
  });

  it.each(pages)('declares exact same-origin favicon paths', (html) => {
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html).toContain(
      '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">',
    );
    expect(html).toContain(
      '<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">',
    );
    expect(html).not.toMatch(/<link rel="icon" href="https?:/u);
  });

  it.each(pages)('generates the decorative canonical upright mark from shared data', (html) => {
    const { regular, gradient, colours } = BRAND_IDENTITY;
    const { viewBox, body } = regular;
    expect(html).toContain(
      `<svg class="mark" viewBox="${String(viewBox.x)} ${String(viewBox.y)} ${String(viewBox.width)} ${String(viewBox.height)}" aria-hidden="true"`,
    );
    expect(html).toContain(`d="${regular.emberPath}"`);
    expect(html).toContain(
      `<linearGradient id="wick-site-ember" x1="${String(gradient.x1)}" y1="${String(gradient.y1)}" x2="${String(gradient.x2)}" y2="${String(gradient.y2)}">`,
    );
    expect(html).toContain(`stop-color="${gradient.start}"`);
    expect(html).toContain(`stop-color="${gradient.end}"`);
    expect(html).toContain(
      `<clipPath id="wick-site-body"><rect x="${String(body.x)}" y="${String(body.y)}" width="${String(body.width)}" height="${String(body.height)}" rx="${String(body.radius)}"></rect></clipPath>`,
    );
    expect(html).toContain(`fill="${colours.trackRegular}"`);
    expect(html).toContain('clip-path="url(#wick-site-body)"');
    expect(html).not.toContain('<span class="mark"><i>');
    expect(html).not.toContain('<script');
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

  it('has no sponsorship content', () => {
    const html = renderLanding();
    expect(html).not.toContain('https://ko-fi.com/remasteredgod');
    expect(html).not.toContain('Sponsor this project');
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

  it('renders exactly one static sponsor link', () => {
    const html = renderProfile(card(), TODAY);
    const sponsorUrl = 'https://ko-fi.com/remasteredgod';

    expect(html.match(new RegExp(sponsorUrl.replace(/[./-]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(html).toContain(
      `<a class="button" href="${sponsorUrl}" target="_blank" rel="noreferrer" referrerpolicy="no-referrer">Sponsor this project</a>`,
    );
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
    for (const forbidden of ['opus', 'sonnet', 'peak hr', 'utilization', 'limit']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('draws a share of the leader, which is not a share of anyone\'s limit', () => {
    // The distinction the forbidden list above turns on. A percentage of the
    // board is public by construction; a percentage of somebody's quota is the
    // thing the schema refuses to hold.
    const withLeader = buildCard(
      'amber-ledger-0042',
      new Map<Period, Standing | null>([['all', standing({ rank: 2, ranked: 300 })]]),
      4,
      1_200,
    );
    expect(withLeader.share).toBe(25);

    const html = renderProfile(withLeader, TODAY);
    expect(html).toContain('width:25%');
    expect(copy(html)).toContain('25%');
  });

  it('omits the share bar rather than drawing an empty one', () => {
    // A board with no leader, or a profile that has published nothing. A 0%
    // track reads as "you are nowhere" rather than "there is nothing to
    // compare against yet".
    const alone = buildCard(
      'amber-ledger-0042',
      new Map<Period, Standing | null>([['all', standing()]]),
      0,
      0,
    );
    expect(alone.share).toBe(0);
    expect(markup(renderProfile(alone, TODAY))).not.toContain('share__track');
  });

  it('does not distinguish a name that never existed from one that left', () => {
    // A page that told you which would let anyone enumerate who had quit.
    const html = renderMissingProfile();
    expect(html).toContain('No such profile');
    expect(html).not.toContain('https://ko-fi.com/remasteredgod');
    expect(html).not.toContain('Sponsor this project');

    const text = copy(html);
    for (const forbidden of ['left', 'deleted', 'removed', 'quit']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

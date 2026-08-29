/**
 * Every public page, as HTML.
 *
 * Pure functions from data to a string. No framework, no client JavaScript, no
 * third-party fonts, no analytics — the same rules the extension follows. It is
 * a leaderboard; it does not need 200 kB of JavaScript to be one.
 *
 * The visual language and the motion come from the `Wick Site` design canvas.
 * What is deliberately *not* carried over is its data model: it draws a plan
 * tier, a chosen `@handle`, a per-viewer "YOU" tag and a live "revalidated 41s
 * ago". The schema has none of those and two of them cannot exist here —
 * `profile.ts` records why a plan tier is an ADR rather than a column, and
 * anything per-viewer would give up the edge cache these pages are built
 * around. The layout, the palette, the stagger and the easing are the design's;
 * the columns are the schema's.
 *
 * **All motion is CSS, in the one inline `<style>` in `page()`.** That is not
 * an aesthetic choice: `server/http.ts` sends
 * `default-src 'none'; style-src 'unsafe-inline'`, so a single `<script>` would
 * mean widening the CSP for the whole site. Nothing here needs one.
 */

import BRAND_IDENTITY from '../brand/v3/geometry.json' with { type: 'json' };
import { SELF_REPORTED_LABEL, type ProfileCard } from './profile.js';
import type { Period } from './periods.js';
import type { Standing } from './ranking.js';

/** Where each board lives. The apex is the landing page, not the board. */
const PERIOD_PATHS: Record<Period, string> = {
  week: '/board',
  month: '/board?p=month',
  all: '/board?p=all',
};

const PERIOD_LABELS: Record<Period, string> = {
  week: 'This week',
  month: 'This month',
  all: 'All time',
};

/** Convert one trusted shared six-digit identity colour to deterministic CSS. */
function withAlpha(hex: string, alpha: number): string {
  if (
    !/^#[\da-f]{6}$/iu.test(hex) ||
    !Number.isFinite(alpha) ||
    alpha < 0 ||
    alpha > 1
  ) {
    throw new Error('invalid identity colour or alpha');
  }

  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  const cssAlpha = String(alpha).replace(/^0\./u, '.');
  return `rgba(${channels.join(',')},${cssAlpha})`;
}

const LEAD_ROW_TINT = withAlpha(BRAND_IDENTITY.gradient.start, 0.045);

/** A static website-only side rail. The server also sends Referrer-Policy: no-referrer. */
function sponsorPanel(): string {
  return `<aside class="sponsor" aria-label="Project sponsorship">
  <a class="button" href="https://ko-fi.com/remasteredgod" target="_blank" rel="noreferrer" referrerpolicy="no-referrer">Sponsor this project</a>
</aside>`;
}

/**
 * Escape text for HTML.
 *
 * Names are validated to `[a-z0-9_-]` before they are stored, so nothing should
 * reach here needing this. It runs anyway: the validator and this renderer are
 * separated by a database and a deployment, and "should" is not a guarantee
 * worth betting a stored-XSS on.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Thousands separators, without pulling in a locale. */
function group(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "3d ago", or the day itself once it stops being recent. */
function ago(day: string | null, today: string): string {
  if (day === null) return '—';
  if (day === today) return 'today';

  const from = Date.parse(`${day}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return escapeHtml(day);

  const days = Math.round((to - from) / 86_400_000);
  if (days === 1) return 'yesterday';
  return days > 0 && days < 30 ? `${String(days)}d ago` : escapeHtml(day);
}

/**
 * Entrance delay for the nth row, as a CSS duration.
 *
 * 45ms apart, from the canvas. Capped so a hundred-row board does not spend
 * four and a half seconds arriving — past the first couple of dozen the stagger
 * has made its point, and everything below the fold should simply be there when
 * the reader gets to it.
 */
function stagger(index: number): string {
  return `${Math.min(0.04 + index * 0.045, 1.1).toFixed(2)}s`;
}

/* ---- The board ----------------------------------------------------------- */

export interface BoardPage {
  period: Period;
  standings: Standing[];
  today: string;
}

export function renderBoard({ period, standings, today }: BoardPage): string {
  const top = standings[0]?.ranked ?? 0;

  const rows = standings
    .map((standing, index) => {
      // Relative to the leader, so the bar reads as a share of the top rather
      // than as progress towards a limit. Bars mean limits everywhere else in
      // this project, so the colour is deliberately not the accent.
      const width = top === 0 ? 0 : Math.max(1, Math.round((standing.ranked / top) * 100));
      const lead = standing.rank === 1;
      const delay = stagger(index);

      return `<div class="row${lead ? ' lead' : ''}" style="animation-delay:${delay}">
  <div class="rank">${String(standing.rank).padStart(2, '0')}</div>
  <div class="handle">${escapeHtml(standing.name)}</div>
  <div class="days hide-sm">${group(standing.days)}${standing.days === 1 ? ' day' : ' days'}</div>
  <div class="bar"><span style="width:${String(width)}%;animation-delay:${delay}"></span></div>
  <div class="num">${group(standing.ranked)}</div>
  <div class="meta hide-sm">${ago(standing.lastDay, today)}</div>
</div>`;
    })
    .join('\n');

  const tabs = (['week', 'month', 'all'] as const)
    .map((option) => {
      const active = option === period ? ' class="on"' : '';
      return `<a href="${PERIOD_PATHS[option]}"${active}>${PERIOD_LABELS[option]}</a>`;
    })
    .join('');

  const body =
    standings.length === 0
      ? `<div class="empty">
  <p class="empty__head">No submissions ${period === 'all' ? 'yet' : 'in this period yet'}.</p>
  <p class="empty__note">The board fills as soon as anyone opts in. Until then it stays
  honest and empty.</p>
</div>`
      : `<div class="scroll"><div class="table">
<div class="row row--head">
  <div class="rank">Rank</div>
  <div class="handle">Handle</div>
  <div class="days hide-sm">Days</div>
  <div class="bar">Share of leader</div>
  <div class="num">Messages</div>
  <div class="meta hide-sm">Last</div>
</div>
${rows}
</div></div>`;

  return page(
    `Leaderboard — Wick`,
    `<header class="head">
  <div class="eyebrow">${mark()} Wick · opt-in leaderboard</div>
  <h1>Who's burning fastest</h1>
  <p class="sub">Messages sent to Claude, reported by people who chose to share it.
  Ranked on the count alone — days are shown so a week reads differently from an
  afternoon, and are not part of the order.</p>
</header>

<nav class="tabs">${tabs}<span class="chip">${SELF_REPORTED_LABEL}</span></nav>

${body}

${sponsorPanel()}

<footer class="foot">
  <p><strong>What gets shared.</strong> A calendar day and how many messages were
  sent on it. Nothing about conversations, projects, models or times of day, and no
  percentage of anyone's limit. Handles are assigned, not chosen.</p>
  <p>${SELF_REPORTED_LABEL} These figures come from software running on each
  participant's own machine and cannot be verified.</p>
  <p><a href="/">About Wick</a> · <a href="https://github.com/RemasteredGod/Wick-">Source</a></p>
</footer>`,
  );
}

/* ---- One profile --------------------------------------------------------- */

/**
 * One participant's page, at `/u/<name>`.
 *
 * Three stat tiles, a share-of-leader bar, and a row per period — the canvas's
 * profile artboard, with its plan tier and enrolment date dropped because the
 * schema holds neither.
 *
 * The self-reported label is not a caller's choice and is rendered twice: once
 * as the chip beside the name and once in the footer. These figures come from
 * software on somebody's own machine, and a page that ranks people has to keep
 * saying it cannot check them.
 */
export function renderProfile(card: ProfileCard, today: string): string {
  const rank = card.standings.find((line) => line.period === 'all')?.rank ?? null;

  const tiles = [
    {
      label: 'Rank',
      value: rank === null ? '—' : `#${String(rank)}`,
      note: 'all time',
      accent: true,
    },
    { label: 'Messages', value: group(card.messages), note: 'all time', accent: false },
    {
      label: 'Streak',
      value: card.streak === 0 ? '—' : `${String(card.streak)}d`,
      note: 'consecutive days',
      accent: false,
    },
  ]
    .map(
      (tile, index) => `<div class="tile" style="animation-delay:${stagger(index)}">
  <div class="tile__label">${tile.label}</div>
  <div class="tile__value${tile.accent ? ' tile__value--accent' : ''}">${tile.value}</div>
  <div class="tile__note">${tile.note}</div>
</div>`,
    )
    .join('\n');

  const periods = card.standings
    .map(
      (line) => `<div class="window">
  <div class="window__label">${PERIOD_LABELS[line.period]}</div>
  <div class="window__note">rank #${String(line.rank)}</div>
  <div class="window__value">${group(line.ranked)}</div>
</div>`,
    )
    .join('\n');

  const share =
    card.share === 0
      ? ''
      : `<div class="share">
  <div class="share__head">
    <span class="share__title">Share of the leader's volume</span>
    <span class="share__pct">${String(card.share)}%</span>
  </div>
  <div class="share__track"><span style="width:${String(card.share)}%"></span></div>
</div>`;

  return page(
    `${card.name} — Wick leaderboard`,
    `<header class="head">
  <div class="eyebrow">${mark()} Wick · opt-in leaderboard</div>
  <h1>${escapeHtml(card.name)}</h1>
  <p class="sub">${group(card.messages)} messages across ${group(card.days)}
  ${card.days === 1 ? 'day' : 'days'}${card.streak > 1 ? `, ${group(card.streak)} in a row` : ''}.
  Last seen ${ago(card.lastDay, today)}.</p>
</header>

<nav class="tabs"><a href="/board">Back to the board</a><span class="chip">${card.label}</span></nav>

<div class="tiles">
${tiles}
</div>

${share}

<div class="windows">
${periods}
</div>

${sponsorPanel()}

<footer class="foot">
  <p><strong>What this page holds.</strong> A name the board assigned, and how many
  messages were reported on each day. Nothing about conversations, projects, models or
  times of day, and no email address.</p>
  <p>${card.label} These figures come from software running on this participant's own
  machine and cannot be verified.</p>
  <p><a href="/">About Wick</a> · <a href="https://github.com/RemasteredGod/Wick-">Source</a></p>
</footer>`,
  );
}

/**
 * The page for a name nobody holds.
 *
 * A 404 that says so plainly. It deliberately does not distinguish "never
 * existed" from "left the board" from "joined but published nothing" — a page
 * that told you which would let anyone enumerate who had quit.
 */
export function renderMissingProfile(): string {
  return page(
    'Not found — Wick leaderboard',
    `<header class="head">
  <div class="eyebrow">${mark()} Wick · opt-in leaderboard</div>
  <h1>No such profile</h1>
  <p class="sub">Nobody on the board goes by that name.</p>
</header>

<div class="notice">
  <p class="notice__code">404 · handle not on the board</p>
  <p class="notice__body">Names are assigned when somebody joins and returned to the pool
  when they go, so a miss here is cheap and says nothing about anyone.</p>
</div>

<nav class="tabs"><a href="/board" class="on">See the board</a></nav>`,
  );
}

/* ---- The landing page ---------------------------------------------------- */

/** The three steps on the landing page. Numbered, from the canvas. */
const STEPS: ReadonlyArray<{ n: string; title: string; body: string }> = [
  {
    n: '01',
    title: 'Install and watch',
    body: 'The extension reads your own usage locally, projects when you will run out, and warns you before you get there. Browser notifications, no setup, nothing leaves the machine.',
  },
  {
    n: '02',
    title: 'Join, if you want to',
    body: 'One click enrols you and the board assigns you a name. It is not derived from anything about you.',
  },
  {
    n: '03',
    title: 'Leave anytime',
    body: 'One click deletes your profile and every day you published, in every browser. Cached pages clear within the minute.',
  },
];

export function renderLanding(): string {
  const steps = STEPS.map(
    (step, index) => `<div class="step" style="animation-delay:${stagger(index)}">
  <div class="step__n">${step.n}</div>
  <div class="step__title">${step.title}</div>
  <div class="step__body">${step.body}</div>
</div>`,
  ).join('\n');

  return page(
    'Wick — know before you run out',
    `<header class="head">
  <div class="eyebrow">${mark()} Wick</div>
  <h1>Know before you run out</h1>
  <p class="sub">A Chrome extension that tracks your Claude usage limits and tells you
  when you will hit them &mdash; in the sidebar, on the toolbar, and as a notification
  before you get there.</p>
</header>

<div class="steps">
${steps}
</div>

<div class="cta">
  <a class="button" href="/board">Open the board</a>
  <span class="cta__note">An opt-in leaderboard · one click from the extension</span>
</div>

<div class="split">
  <div class="split__half">
    <div class="split__title">Shared, if you join</div>
    <div class="split__body">An assigned name, and how many messages you sent on each
    calendar day.</div>
  </div>
  <div class="split__half">
    <div class="split__title">Never shared</div>
    <div class="split__body">Conversation content, titles, times of day, model names, or
    any percentage of your limit.</div>
  </div>
</div>

<footer class="foot">
  <p><a href="https://github.com/RemasteredGod/Wick-">Source</a> ·
  <a href="https://github.com/RemasteredGod/Wick-/blob/master/PRIVACY.md">Privacy</a> ·
  AGPL-3.0-or-later</p>
</footer>`,
  );
}

/* ---- The shell ----------------------------------------------------------- */

/** The decorative canonical v3 mark; quota semantics do not attach to site identity. */
function mark(): string {
  const { regular, gradient, colours } = BRAND_IDENTITY;
  const { viewBox, body } = regular;
  const specimenRemaining = 26;
  const fillHeight = body.height * (specimenRemaining / 100);
  const fillY = body.y + body.height - fillHeight;

  return `<svg class="mark" viewBox="${String(viewBox.x)} ${String(viewBox.y)} ${String(viewBox.width)} ${String(viewBox.height)}" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="wick-site-ember" x1="${String(gradient.x1)}" y1="${String(gradient.y1)}" x2="${String(gradient.x2)}" y2="${String(gradient.y2)}">
      <stop offset="0" stop-color="${gradient.start}"></stop>
      <stop offset="1" stop-color="${gradient.end}"></stop>
    </linearGradient>
    <clipPath id="wick-site-body"><rect x="${String(body.x)}" y="${String(body.y)}" width="${String(body.width)}" height="${String(body.height)}" rx="${String(body.radius)}"></rect></clipPath>
  </defs>
  <path class="mark__ember" d="${regular.emberPath}" fill="url(#wick-site-ember)"></path>
  <rect x="${String(body.x)}" y="${String(body.y)}" width="${String(body.width)}" height="${String(body.height)}" rx="${String(body.radius)}" fill="${colours.trackRegular}"></rect>
  <g clip-path="url(#wick-site-body)"><rect x="${String(body.x)}" y="${String(fillY)}" width="${String(body.width)}" height="${String(fillHeight)}" fill="${gradient.end}"></rect></g>
</svg>`;
}

/**
 * The one shell every page renders through.
 *
 * One inline `<style>`, and everything — palette, layout, motion — comes out of
 * it. `prefers-reduced-motion` turns the whole animation block off rather than
 * shortening it: the entrance animations start elements at `opacity:0`, so a
 * reader who has asked for no motion must get the finished state, not a faster
 * version of the same movement.
 */
function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="dark">
<style>
:root{--bg:#0f0e0d;--card:${BRAND_IDENTITY.colours.tile};--tile:#171614;--line:#262421;--row:#1d1c1a;
--text:#f2efe9;--head:#efeae2;--bright:#e8e4dd;--body:#c9c4bb;--dim:#8a857d;
--faint:#6f6a63;--ghost:${BRAND_IDENTITY.colours.trackSmall};--accent:${BRAND_IDENTITY.gradient.end};--brand-track:${BRAND_IDENTITY.colours.trackRegular};
--track:#232120;--fill:#3c3a36;--lead:#5c5751;
--mono:ui-monospace,Menlo,monospace;--sans:'Helvetica Neue',Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
font-size:13.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:26px 20px 80px}
.card{border:1px solid var(--line);border-radius:16px;background:var(--card);
padding:38px 40px 30px;display:flex;flex-direction:column;gap:26px}
a{color:var(--body);text-decoration:none;border-bottom:1px solid #3a3833}
a:hover{color:var(--text);border-bottom-color:var(--faint)}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:#3a3835;border-radius:8px}

/* ---- header ---- */
.head{display:flex;flex-direction:column;gap:12px;
animation:wRise .5s cubic-bezier(.2,.7,.2,1) both}
.eyebrow{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:11px;
letter-spacing:.16em;text-transform:uppercase;color:var(--dim);animation:wFade .6s ease both}
.mark{display:block;width:6px;height:17px;flex:none}
.mark__ember{transform-origin:center;animation:wFlicker 2.6s ease-in-out infinite}
h1{font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.08;
letter-spacing:-.015em;color:var(--head);margin:9px 0 0;font-weight:400}
.sub{color:var(--dim);max-width:56ch;margin:9px 0 0}

/* ---- tabs ---- */
.tabs{display:flex;align-items:center;gap:6px;margin:0;flex-wrap:wrap;
animation:wFade .5s ease both}
.tabs a{padding:5px 12px;border-radius:999px;font-family:var(--mono);font-size:11px;
background:transparent;border:1px solid var(--line);color:var(--faint)}
.tabs a.on{background:#242220;border-color:var(--brand-track);color:var(--text)}
.tabs a:hover{color:var(--text);border-color:var(--brand-track)}
.chip{margin-left:auto;font-family:var(--mono);font-size:10px;letter-spacing:.12em;
text-transform:uppercase;color:var(--ghost);border:1px solid var(--line);
border-radius:999px;padding:4px 10px}

/* ---- board ---- */
.scroll{overflow-x:auto}
.table{min-width:620px;display:flex;flex-direction:column}
.row{display:grid;grid-template-columns:44px 1fr 78px 130px 84px 76px;gap:14px;
align-items:center;padding:10px 4px;border-bottom:1px solid var(--row);
animation:wRise .45s cubic-bezier(.2,.7,.2,1) both}
.row:last-child{border-bottom:0}
.row:hover{background:#1b1a18}
.row--head{padding:0 4px 9px;border-bottom:1px solid var(--line);font-family:var(--mono);
font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ghost);
animation:none}
.row--head:hover{background:transparent}
.row.lead{background:${LEAD_ROW_TINT}}
.rank{font-family:var(--mono);font-size:13px;color:var(--faint)}
.lead .rank{color:var(--accent)}
.handle{font-size:13.5px;color:#c1bcb4;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis}
.lead .handle{color:var(--text)}
.days{font-family:var(--mono);font-size:11.5px;color:#7d786f}
.bar{height:5px;border-radius:5px;background:var(--track);overflow:hidden}
.row--head .bar{height:auto;background:none;overflow:visible}
.bar span{display:block;height:100%;border-radius:5px;background:var(--fill);
transform-origin:left;animation:wBar .8s cubic-bezier(.2,.8,.2,1) both}
.lead .bar span{background:var(--lead)}
.num{text-align:right;font-family:var(--mono);font-size:13px;
font-variant-numeric:tabular-nums;color:#a4a09a}
.lead .num{color:var(--text)}
.row--head .num{text-align:right}
.meta{font-size:11px;color:var(--ghost);text-align:right;white-space:nowrap}

/* ---- empty and 404 ---- */
.empty,.notice{border:1px dashed #302e2b;border-radius:12px;padding:30px 22px;
display:flex;flex-direction:column;gap:8px;animation:wFade .5s ease both}
.empty{text-align:center;align-items:center}
.empty__head{font-size:14px;color:#a4a09a;margin:0}
.empty__note{font-size:12.5px;color:var(--faint);max-width:40ch;margin:0}
.notice__code{font-family:var(--mono);font-size:11px;color:#b8654a;margin:0}
.notice__body{font-size:13px;color:var(--dim);max-width:48ch;margin:0}

/* ---- profile ---- */
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#211f1e;
border:1px solid #211f1e;border-radius:12px;overflow:hidden}
.tile{background:var(--tile);padding:16px 18px;display:flex;flex-direction:column;gap:8px;
animation:wRise .5s cubic-bezier(.2,.7,.2,1) both}
.tile__label{font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;
text-transform:uppercase;color:var(--ghost)}
.tile__value{font-family:var(--mono);font-size:27px;line-height:1;
font-variant-numeric:tabular-nums;color:var(--text)}
.tile__value--accent{color:var(--accent)}
.tile__note{font-size:11.5px;color:var(--faint)}
.share{display:flex;flex-direction:column;gap:9px}
.share__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.share__title{font-size:12.5px;color:var(--body)}
.share__pct{font-family:var(--mono);font-size:11.5px;color:#7d786f}
.share__track{height:7px;border-radius:7px;background:var(--track);overflow:hidden}
.share__track span{display:block;height:100%;border-radius:7px;background:var(--accent);
transform-origin:left;animation:wBar .9s cubic-bezier(.2,.8,.2,1) both}
.windows{display:flex;flex-direction:column;border-top:1px solid #211f1e}
.window{display:grid;grid-template-columns:110px 1fr 110px;gap:14px;align-items:center;
padding:11px 2px;border-bottom:1px solid var(--row)}
.window__label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;
text-transform:uppercase;color:var(--ghost)}
.window__note{font-size:12.5px;color:var(--dim)}
.window__value{text-align:right;font-family:var(--mono);font-size:13px;
font-variant-numeric:tabular-nums;color:var(--body)}

/* ---- landing ---- */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.step{display:flex;flex-direction:column;gap:7px;
animation:wRise .5s cubic-bezier(.2,.7,.2,1) both}
.step__n{font-family:var(--mono);font-size:10.5px;color:var(--accent)}
.step__title{font-size:13.5px;color:var(--bright)}
.step__body{font-size:12.5px;line-height:1.6;color:var(--dim)}
.cta{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.button{border:1px solid var(--brand-track);border-radius:9px;padding:9px 16px;font-size:13px;
color:var(--text);background:#1d1b19}
.button:hover{background:#272522;border-color:#575249}
.cta__note{font-family:var(--mono);font-size:11px;color:var(--faint)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:14px;border-top:1px solid #211f1e;
padding-top:20px}
.split__half{display:flex;flex-direction:column;gap:6px}
.split__title{font-size:12.5px;color:var(--body)}
.split__body{font-size:12.5px;line-height:1.7;color:#7d786f}

/* ---- footer ---- */

/* ---- website-only sponsor rail ----
   Reuses the established button component; this rule only takes it out of flow. */
.sponsor{position:fixed;inset-inline-end:0;top:50%;transform:translateY(-50%);
font-family:var(--mono)}

.foot{padding-top:20px;border-top:1px solid #211f1e;color:var(--ghost);font-size:12px;
max-width:640px}
.foot strong{color:var(--body);font-weight:500}
.foot p{margin:0 0 10px}
.foot p:last-child{margin:0}

/* ---- motion ----
   Four keyframes, and every animated rule above references one of them. */
@keyframes wRise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@keyframes wFade{from{opacity:0}to{opacity:1}}
@keyframes wBar{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes wFlicker{0%,100%{opacity:1}38%{opacity:.72}61%{opacity:1}79%{opacity:.85}}

@media(max-width:1240px){.sponsor{display:none}}

@media(max-width:720px){
.hide-sm{display:none}
.table{min-width:0}
.row{grid-template-columns:34px 1fr 90px 64px;gap:10px}
h1{font-size:26px}
.wrap{padding:20px 16px 60px}
.card{padding:24px 20px 20px;border-radius:14px;gap:22px}
.steps,.tiles,.split{grid-template-columns:1fr}
.tiles{gap:1px}
}

/* Reduced motion turns the block off rather than speeding it up: every entrance
   starts at opacity:0, so a shorter version would still be movement. */
@media(prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none!important;transition:none!important}
}
</style>
</head>
<body><div class="wrap"><div class="card">
${content}
</div></div></body>
</html>`;
}

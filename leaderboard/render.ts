/**
 * The public board, as HTML.
 *
 * A pure function from standings to a string. No framework, no client
 * JavaScript, no third-party fonts, no analytics — the same rules the extension
 * follows. It is a table; it does not need 200 kB of JavaScript to be one.
 *
 * The visual language is lifted from the v2 design archive: the warm near-black
 * ground, the terracotta accent, a serif display face against a sans body. What
 * is deliberately *not* carried over is the archive's data model. It draws a
 * plan tier, a message count and a friends graph, and each of those is a
 * personal field with no route into the schema ADR 0006 accepted. Adding one is
 * an ADR, not a column.
 *
 * The period switcher is three ordinary links, not a control. With no client
 * script there is nothing to hold state, and three URLs are better anyway —
 * they can be shared, bookmarked and cached individually.
 */

import { SELF_REPORTED_LABEL } from './profile';
import type { Period } from './periods';
import type { Standing } from './ranking';

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

export interface BoardPage {
  period: Period;
  standings: readonly Standing[];
  today: string;
}

export function renderBoard({ period, standings, today }: BoardPage): string {
  const top = standings[0]?.ranked ?? 0;

  const rows = standings
    .map((standing) => {
      // Relative to the leader, so the bar reads as a share of the top rather
      // than as progress towards a limit. Bars mean limits everywhere else in
      // this project, so the colour is deliberately not the accent.
      const width = top === 0 ? 0 : Math.max(1, Math.round((standing.ranked / top) * 100));
      const lead = standing.rank === 1;

      return `<tr${lead ? ' class="lead"' : ''}>
  <td class="rank">${String(standing.rank).padStart(2, '0')}</td>
  <td class="handle">${escapeHtml(standing.name)}</td>
  <td class="bar"><span style="width:${String(width)}%"></span></td>
  <td class="num strong">${group(standing.counters.output)}</td>
  <td class="num">${group(standing.counters.input)}</td>
  <td class="num faint hide-sm">${group(standing.counters.cacheRead)}</td>
  <td class="num hide-sm">${group(standing.sessions)}</td>
  <td class="meta hide-sm">${ago(standing.lastDay, today)}</td>
</tr>`;
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
      ? `<p class="empty">No submissions ${period === 'all' ? 'yet' : 'in this period yet'}.</p>`
      : `<div class="scroll"><table>
<thead><tr>
  <th class="rank">Rank</th><th>Handle</th><th></th>
  <th class="num">Output</th><th class="num">Input</th>
  <th class="num hide-sm">Cache reads</th><th class="num hide-sm">Sessions</th>
  <th class="hide-sm">Last</th>
</tr></thead>
<tbody>
${rows}
</tbody></table></div>`;

  return page(
    `Leaderboard — Wick`,
    `<header class="head">
  <div class="eyebrow">${mark()} Wick · opt-in leaderboard</div>
  <h1>Who's burning fastest</h1>
  <p class="sub">Claude Code token usage, reported by people who chose to share it.
  Ranked on input plus output. Cache reads are shown and counted towards nothing.</p>
</header>

<nav class="tabs">${tabs}<span class="chip">${SELF_REPORTED_LABEL}</span></nav>

${body}

<footer class="foot">
  <p><strong>What gets shared.</strong> A day, four token counters and a session count.
  Nothing about conversations, projects, paths or prompts. Handles are assigned, not chosen.</p>
  <p>${SELF_REPORTED_LABEL} These figures come from software running on each
  participant's own machine and cannot be verified.</p>
  <p><a href="/">About Wick</a> · <a href="https://github.com/RemasteredGod/Wick-">Source</a></p>
</footer>`,
  );
}

/** The mark: a flame over a bar, as the archive draws it. */
function mark(): string {
  return `<span class="mark"><i></i><b></b></span>`;
}

/**
 * The shell.
 *
 * Every value is a literal rather than a token reference: this file is served
 * standalone and cannot import the extension's stylesheet, so the palette is
 * duplicated here on purpose. If a colour changes in `src/styles/tokens.css` it
 * must be changed here too — which is the cost of the page not shipping a
 * build step.
 */
function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="dark">
<style>
:root{--bg:#141312;--card:#1a1917;--line:#2b2926;--row:#211f1e;--text:#f2efe9;
--dim:#8a857d;--faint:#6f6a63;--ghost:#57534d;--accent:#c96442;--flame:#e8a33d;
--track:#2b2926;--fill:#3c3a36;--lead:#5c5751;
--mono:ui-monospace,Menlo,monospace;--sans:'Helvetica Neue',Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
font-size:13.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:44px 24px 90px}
a{color:var(--dim);text-decoration:none}
a:hover{color:var(--text)}
.eyebrow{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:11px;
letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.mark{display:inline-flex;flex-direction:column;align-items:center;gap:2px}
.mark i{width:4px;height:4px;background:var(--flame);border-radius:50% 50% 50% 0;transform:rotate(45deg)}
.mark b{width:5px;height:15px;border-radius:3px;background:#332f2b;display:block}
h1{font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.1;
letter-spacing:-.01em;color:#efeae2;margin:9px 0 0;font-weight:400}
.sub{color:var(--dim);max-width:560px;margin:9px 0 0}
.tabs{display:flex;align-items:center;gap:3px;margin:28px 0 12px;flex-wrap:wrap}
.tabs a{padding:6px 14px;border-radius:7px;font-size:12.5px;background:transparent}
.tabs a.on{background:var(--line);color:var(--text)}
.chip{margin-left:auto;font-family:var(--mono);font-size:10px;letter-spacing:.12em;
text-transform:uppercase;color:var(--faint);border:1px solid var(--line);
border-radius:999px;padding:4px 10px}
.scroll{overflow-x:auto;border:1px solid var(--line);background:var(--card);border-radius:14px}
table{width:100%;border-collapse:collapse;min-width:640px}
th{font-family:var(--mono);font-size:10px;letter-spacing:.13em;text-transform:uppercase;
color:var(--faint);font-weight:400;text-align:left;padding:12px 10px;border-bottom:1px solid var(--row)}
td{padding:11px 10px;border-bottom:1px solid var(--row);vertical-align:middle}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#201f1d}
.rank{font-family:var(--mono);color:var(--faint);width:56px;padding-left:18px}
tr.lead .rank{color:var(--accent)}
.handle{font-size:13.5px;color:#d6d1c9;white-space:nowrap}
tr.lead .handle{color:var(--text)}
.bar{width:170px}
.bar span{display:block;height:5px;border-radius:5px;background:var(--fill)}
tr.lead .bar span{background:var(--lead)}
.num{font-family:var(--mono);font-size:13px;text-align:right;color:#c9c4bb;
font-variant-numeric:tabular-nums}
.num.strong{color:var(--text)}
.num.faint{color:var(--ghost)}
.meta{font-size:11px;color:var(--faint);text-align:right;padding-right:18px;white-space:nowrap}
.empty{color:var(--dim);border:1px solid var(--line);background:var(--card);
border-radius:14px;padding:28px;text-align:center}
.foot{margin-top:26px;color:var(--faint);font-size:12px;max-width:640px}
.foot strong{color:#c9c4bb;font-weight:500}
.foot p{margin:0 0 10px}
@media(max-width:720px){.hide-sm{display:none}table{min-width:0}.bar{width:90px}
h1{font-size:26px}.wrap{padding:28px 16px 60px}}
</style>
</head>
<body><div class="wrap">
${content}
</div></body>
</html>`;
}

/** The landing page. Static, and the only thing at the apex. */
export function renderLanding(): string {
  return page(
    'Wick — know before you run out',
    `<header class="head">
  <div class="eyebrow">${mark()} Wick</div>
  <h1>Know before you run out</h1>
  <p class="sub">A Chrome extension that tracks your Claude usage limits and tells you
  when you will hit them &mdash; in the sidebar, on the toolbar, and on Telegram if you want it.</p>
</header>

<nav class="tabs">
  <a href="https://github.com/RemasteredGod/Wick-" class="on">Get it on GitHub</a>
  <a href="/board">Leaderboard</a>
</nav>

<div class="scroll" style="padding:22px 20px">
  <p class="foot" style="margin:0;max-width:none">
    <strong>Percentages, measured not guessed.</strong> Wick reads the numbers claude.ai
    already reports. It never estimates a token count, and a limit it has not seen is
    shown as unknown rather than as zero.
  </p>
</div>

<div class="scroll" style="padding:22px 20px;margin-top:12px">
  <p class="foot" style="margin:0;max-width:none">
    <strong>Alerts with no server.</strong> Telegram alerts go straight from your browser
    to a bot you create yourself. Nothing passes through anyone else's infrastructure,
    and there is no account to make.
  </p>
</div>

<div class="scroll" style="padding:22px 20px;margin-top:12px">
  <p class="foot" style="margin:0;max-width:none">
    <strong>An opt-in leaderboard.</strong> Separate, optional, and off by default.
    It ranks Claude Code token usage reported by a command-line tool you install
    deliberately. <a href="/board">See the board</a>.
  </p>
</div>

<footer class="foot">
  <p><a href="https://github.com/RemasteredGod/Wick-">Source</a> ·
  <a href="https://github.com/RemasteredGod/Wick-/blob/master/PRIVACY.md">Privacy</a> ·
  AGPL-3.0-or-later</p>
</footer>`,
  );
}

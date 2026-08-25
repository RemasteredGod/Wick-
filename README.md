# Wick

A Chrome extension that tracks Claude.ai usage limits and tells you **when you
will run out** — not just where you are right now.

Most usage trackers show a percentage. A percentage tells you the past. Wick
answers the question you actually have on Wednesday afternoon: *will this last
until Thursday's reset?*

## What makes it different

**Burn-rate projection.** "At your current pace you run out Tuesday evening —
two days before reset." One sentence, at the top of the panel. Everything else
in the interface is evidence for it.

**Local history.** A rolling daily record of peak usage per window, kept on your
machine. The projection needs something to project from, and the record doubles
as a view of your own patterns. History is written from the first release — it
cannot be backfilled.

**Telegram alerts.** Threshold crossings pushed to your phone, so you never have
to open the popup to find out you are nearly out.

**Optional Claude Code leaderboard.** The separate `wick-cc` reporter reads only
first-party usage counters from local Claude Code transcripts, aggregates them
on the machine, and can publish daily totals to a public, self-reported board.
It is off until the user explicitly opts in.

The toolbar icon is a gauge, not a logo. It depletes and changes colour as you
consume quota, so status is readable without clicking.

## What it does not do

Wick does not estimate tokens. It has no tokenizer and no table of per-feature
costs. claude.ai's server already computes a percentage per limit window, and
the extension reads that number. The separate `wick-cc` reporter likewise uses
only token counts already written by Claude Code's API; it never estimates a
missing count. See
[`docs/decisions/0001-no-token-estimation.md`](docs/decisions/0001-no-token-estimation.md)
and
[`docs/decisions/0005-claude-code-token-counts.md`](docs/decisions/0005-claude-code-token-counts.md).

## Status

Early, but no longer a shell. The extension builds, loads, collects, projects
and draws its own toolbar gauge, and every number on screen comes from
`chrome.storage.local` rather than from a placeholder.

Two things still require operator or account access outside this repository: the
protocol has not been checked against live traffic, and the Cloudflare relay has
not been deployed. The relay, D1 schema, bot commands, public page, digest, and
standalone reporter are implemented in their sibling projects. Until live
protocol verification is done, treat extension readings as provisional —
`docs/protocol.md` is a hypothesis about undocumented behaviour, and it says so
on its first line.

| Milestone | |
|---|---|
| M1 | Scaffold, design tokens, interface shell — done |
| M2 | Verify the protocol against live traffic — **outstanding**, needs a signed-in session in DevTools |
| M3 | Real data — collector, store, polling — done |
| M4 | Daily history and the projection engine — done |
| M5 | Toolbar gauge rendering — done |
| M6 | Telegram relay — extension and Worker implemented at `relay.usewick.lol`; deployment outstanding |
| M7 | Claude Code reporter and self-reported leaderboard — implemented; deployment and package publication outstanding |

Gemini and ChatGPT support, and cross-model conversation handoff, are on the
roadmap beyond v1. They are not being built now.

## Install from source

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, and select the `dist/` directory

For development with hot reload:

```sh
pnpm dev
```

Run the tests:

```sh
pnpm test
```

## Permissions, and why

| Permission | Why |
|---|---|
| `storage` | Local snapshot and daily history |
| `alarms` | Scheduled polling |
| `cookies` | Reading `lastActiveOrg` on claude.ai to identify your active organisation |
| `webRequest` | Detecting account and billing changes so cached state can be invalidated. Headers only — MV3 cannot read response bodies, and Wick does not try |
| `notifications` | Threshold alerts |

Host access is `https://claude.ai/*` and nothing else. Wick does not request
`<all_urls>`.

One host permission is *optional*: the Telegram relay's origin. It is not part
of the install prompt, and Wick asks for it from the Connect button in settings
— so if you never set up Telegram alerts you are never asked, and if you change
your mind Chrome lets you take it back. Everything else in the extension works
without it.

## Privacy

Browser usage stays local by default. Telegram alerts and aggregate Claude Code
leaderboard submissions leave the machine only after their separate, explicit
setup and opt-in steps. No analytics, telemetry, or crash reporting. See
[`PRIVACY.md`](PRIVACY.md).

## Architecture

Four layers, one direction of dependency:

```
collector → store → projection → presentation
```

- **Collector** (`src/background/collector.ts`) — the only module that touches
  the network or reads cookies.
- **Store** (`src/background/store.ts`) — `chrome.storage.local`. A `current`
  snapshot and append-only `history` rollups.
- **Projection** (`src/core/projection.ts`) — pure functions, no `chrome.*`, no
  I/O. Heavily tested. This is the part that has to be right.
- **Presentation** (`src/popup/`, `src/content/`) — reads the store, never
  fetches.

Provider-specific logic is confined to `src/providers/`. Adding another provider
should mean writing one file.

Contributors and AI agents: read [`AGENTS.md`](AGENTS.md) before your first
change. It records constraints — including a clean-room rule — that are not
obvious from the code.

## Licence

[AGPL-3.0-or-later](LICENSE).

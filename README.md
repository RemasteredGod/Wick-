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

**Alerts that need no setup.** Threshold crossings arrive as browser
notifications, so you never have to open the popup to find out you are nearly
out. No account, no credential, no server.

**Optional leaderboard.** One number a day — how many messages you sent —
published under a name the board assigns you. One Claude account is one profile
across every browser you sign into, with nothing to link up. Off until you press
Join, and Leave deletes everything you published.

The toolbar icon is a gauge, not a logo. It depletes and changes colour as you
consume quota, so status is readable without clicking.

## What it does not do

Wick does not estimate tokens. It has no tokenizer and no table of per-feature
costs. claude.ai's server already computes a percentage per limit window, and
the extension reads that number. The leaderboard ranks message counts for the
same reason: it is a number the extension already has, rather than one it would
have to invent. See ADR 0001.

## Status

Wick is pre-release. The extension builds, loads, collects, projects, draws its
own toolbar gauge, and reads its displayed state from `chrome.storage.local`.
Alerts are local browser notifications and need no server or account.

The collector depends on an undocumented protocol that has not yet received the
required owner-led verification against live signed-in traffic. Until that gate
is closed, extension readings remain provisional.

The optional leaderboard implementation, Vercel functions, Supabase schema,
ordered migrations, and production runbook are present in this repository. The
repository cannot establish whether the configured host is deployed or healthy;
Join works only when that host and its database are correctly deployed,
configured, permitted, and reachable. **Launch remains blocked** on the manual
and hosted gates in [`RELEASING.md`](RELEASING.md), including protocol
verification, a proved-restorable database backup and staged migration,
effective privilege and atomic Leave checks, hosted WAF/cache/`429` observation,
Windows Chrome smoke testing, privacy/store review, and explicit owner approval
for each production or publishing action.

| Milestone | |
|---|---|
| M1 | Scaffold, design tokens, interface shell — done |
| M2 | Verify the protocol against live traffic — **outstanding manual gate** |
| M3 | Real data — collector, store, polling — done |
| M4 | Daily history and the projection engine — done |
| M5 | Toolbar gauge rendering — done |
| M6 | Threshold alerts as local notifications — done |
| M7 | Self-reported leaderboard — implementation and runbook present; **hosted launch gates outstanding** |

Gemini and ChatGPT support, and cross-model conversation handoff, are on the
roadmap beyond v1. They are not being built now.

## Install from source

Requires Node 24 and the pnpm version pinned in `package.json`.

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

One host permission is *optional*: the leaderboard's own origin. It is not part
of the install prompt, and Wick asks for it from the Join button in settings —
so if you never join the board you are never asked, and if you change your mind
Chrome lets you take it back. Everything else in the extension works without
it.

## Privacy

Everything stays local by default. Alerts are browser notifications and involve
no network at all. Nothing leaves the machine until you press Join — after which
the board holds your Claude account's email as your profile's key, and receives a
daily message count. **Nothing verifies that address**, so anyone who knows it
could claim your profile; the board is self-reported fun and this is the price of
it needing no setup. No analytics, telemetry, or crash reporting. See
[`PRIVACY.md`](PRIVACY.md), which spells both out.

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

The leaderboard is a separate deployment sharing the repo, and shares no code
with the extension:

- **`leaderboard/`** — pure logic. The metric, the periods, the assigned names,
  the page renderers. No I/O, no database, no `process`.
- **`server/`** — the `BoardStore` port and its Supabase adapter, over PostgREST
  with no SDK.
- **`api/`** — six Vercel functions: the landing page, the board, a profile,
  and the enrol/submit/leave endpoints the extension calls.

Contributors and AI agents: read [`AGENTS.md`](AGENTS.md) before your first
change. It records constraints — including a clean-room rule — that are not
obvious from the code.

## Licence

[AGPL-3.0-or-later](LICENSE).

# Plan — relay origin, Claude Code leaderboard, Telegram surface

Status: **proposed, not started.** No source file has been changed for it.

One thing has moved since this plan was first written: **ADR 0003 was amended on
2026-08-25** to accept the hosting platform's own request log, including IP
addresses. That was a decision about the alert relay, not about the leaderboard,
but it changes two things here — the host is no longer chosen by the logging
policy (§2.1), and §1.2's privacy argument now starts from a slightly weaker
baseline than it did.

Owner decisions are marked **[decide]**. Two of them have to be settled before
any of this is worth building, because they reverse standing decisions in
the decision records.

---

## 0. What this plan is, in one paragraph

Wick today is a local-only percentage tracker for claude.ai, plus an optional
Telegram alert path through a relay that stores nothing about usage. This plan
adds a **public leaderboard of Claude Code token usage**, on
`usewick.lol`, fed by an opt-in reporter on the user's own machine, with
Telegram as the identity and notification surface. It also finally pins the
relay to a real origin.

That is a different product posture from the one the repository currently
documents, and the plan says so out loud in §1 rather than burying it.

---

## 1. What this reopens

`AGENTS.md` says: *"Each of these was considered and deliberately rejected. See
the decision records. Reopening them requires a new decision record."* Two are
being reopened.

### 1.1 Token counting — ADR 0001

ADR 0001 (no token estimation) rules out token counting. A token
leaderboard needs token counts, so on its face this is a straight reversal.

It is not, and the distinction is the whole reason this is buildable:

- **ADR 0001 rejects *estimating* tokens** — a tokenizer, per-feature cost
  tables, cache-hit inference. It rejects guessing at a number the server
  already knows.
- **Claude Code writes the server's own counts to disk.** Every assistant
  message in `~/.claude/projects/**/*.jsonl` carries a `usage` object with
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and
  `cache_read_input_tokens`, as reported by the API. Reading them is the same
  act as reading claude.ai's `utilization` — taking a number the server
  computed, not inventing one.

So the new record supersedes ADR 0001 **narrowly**: token *counts read from a
first-party record* are in scope; token *estimation* stays rejected, for the
extension and for the reporter alike. If the reporter ever cannot find a count,
it reports nothing for that session rather than estimating one.

**[decide]** Write ADR 0005 (Claude Code token counts) saying
exactly that, or reject the leaderboard.

### 1.2 Usage data leaving the machine — ADR 0003 and PRIVACY.md

This is the bigger one, and it cannot be finessed.

ADR 0003 (relay design) lists what the relay stores and
then lists what it refuses to store, including:

> **No percentages, window keys, paces, or exhaustion estimates.** These are
> what the extension exists to compute and they never leave the machine in a
> stored form.

A leaderboard is, definitionally, usage data leaving the machine and being
stored, ranked, and published. `PRIVACY.md`'s headline — "nothing leaves your
machine except the alerts you configured" — stops being true the moment anyone
opts in.

The plan's position, which the new record has to state and defend:

- The leaderboard is **a separate, opt-in feature with its own storage table**,
  not a loosening of the alert relay. A user who never opts in is in exactly
  the position ADR 0003 describes — which, since the 2026-08-25 amendment,
  includes a short-lived platform request log they should be told about either
  way.
- **A submission is one request per user per day.** In the platform's log that
  is a far duller line than an alert: "this token submitted today", not "this
  person hit 80% at 14:02 on Tuesday". Worth stating in the record, because it
  is one of the few places where the leaderboard is *less* revealing than the
  feature that already shipped.
- What is submitted is **a daily total per person**, not a stream. No project
  names, no file paths, no prompts, no per-session detail, no timestamps finer
  than the day.
- Opting out deletes the rows. `/forget` already exists and gains the new table.

**[decide]** Write ADR 0006 (the leaderboard), and rewrite
`PRIVACY.md`'s headline sentence to name both exceptions — alerts, and
leaderboard submissions — instead of one. Anything less is a privacy promise the
software does not keep.

---

## 2. Naming and origins

Domain: **usewick.lol** (registered). **[confirm]** that the zone is on
Cloudflare — the "zone already there" line in §2.1 assumed the previous domain.

| Hostname | What | Pinned where |
|---|---|---|
| `relay.usewick.lol` | The API: alerts, connect, revoke, delete, leaderboard submit | `optional_host_permissions` in the extension — **effectively permanent** |
| `usewick.lol` | The public leaderboard page | Nowhere. Free to move. |

Two hostnames on purpose. The API origin is baked into every installed
extension and changing it forces every user to re-grant the optional
permission; the page is a link and can move whenever. Keeping them separate
means a redesign of the site never touches the extension.

### 2.1 Where it runs — **[decide]**

Until the 2026-08-25 amendment this was settled by elimination: ADR 0003
required request logging to be off at the proxy, and Cloudflare Workers was the
only free host where that is a setting rather than a wish. That constraint is
gone, so the choice is now an ordinary engineering one.

| | Cloudflare Workers + D1 | Vercel + Neon/Upstash |
|---|---|---|
| Vendors holding user data | **one** | two — Vercel has no first-party SQL since Dec 2024 |
| Free ceiling for this workload | ~16,000 installs (§9) | ~4,000–5,000 installs (§9) |
| Custom domain on `usewick.lol` | free, once the zone is added | free |
| Request log | can be off; now kept anyway, at minimum retention | always on, 1 hour on Hobby |
| Bot webhook | fine | fine |
| Terms | no restriction | Hobby is **non-commercial**; the Ko-fi link makes that at least arguable |
| Page DX | plain, hand-rolled | better, if the page ever grows |

**Recommendation: Cloudflare for `relay.usewick.lol`.** Not because of
logging any more, but because the relay is an API with a database and a bot
webhook, and Cloudflare does all three in one account with roughly three times
the free headroom. The second vendor is the real cost of the Vercel route: the
`chat_id` address book would sit with Neon or Upstash, which means a second
operator in the threat model and a second privacy policy to read.

The page (§8) is a different question and can go either way — it holds no
secrets and serves public data. Starting it on the same Worker keeps the
deployment to one thing; moving it to Vercel later costs a DNS record, because
§2's split put it on a hostname nothing pins.

### 2.2 Phase 0 — wire the origin (30 minutes, no leaderboard needed)

Five references to the placeholder `relay.wick.tools`, two of them
load-bearing. They must match character for character:

- `src/background/relay.ts:39` — `RELAY_ORIGIN`
- `src/manifest.ts` — `RELAY_MATCH`
- ADR 0003 (relay design) — three mentions, plus the
  "that host is a placeholder" paragraph, which becomes a statement of fact
- `README.md` — the M6 row still says the relay has no home
- `PRIVACY.md` — same

This is worth doing on its own, before any decision above is settled. It
unblocks the Telegram alert path, which is already built.

---

## 3. Where Claude Code usage actually comes from

**The extension cannot supply it.** Wick is a browser extension reading
claude.ai; Claude Code is a terminal program writing to the local filesystem. They
share a vendor and nothing else. This feature needs a second collector, on the
machine, outside the browser.

Three sources exist. The recommendation is the first, triggered by the third.

| Source | What it gives | Cost to the user |
|---|---|---|
| **`~/.claude/projects/**/*.jsonl`** *(recommended)* | Per-message `usage` objects with the four token counts and the model id. Ground truth, already on disk, no configuration | Install a small CLI |
| Claude Code OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) | `claude_code.token.usage` counters with model and type attributes | Needs an OTLP endpoint configured; more moving parts, and points a metrics pipe at a third party |
| Claude Code hooks (`SessionEnd`, `Stop`) | A place to *run* something at the right moment | Trivial, but supplies no numbers by itself |

**Recommended shape:** a small CLI — working name `wick-cc` — that reads the
JSONL transcripts, aggregates locally, and submits one daily total. A
`SessionEnd` hook invokes it, so there is no daemon and no scheduler. It ships
from its own repository, like the relay, under the same licence.

Rules the reporter inherits from the rest of the project, and which the ADR
should restate:

- **It reads only the `usage` objects and the model id.** Not prompts, not
  responses, not file paths, not project names, not `cwd`. The JSONL contains
  the user's entire working history; the reporter must be auditable line by line
  in its refusal to look at it.
- **Local aggregation.** What leaves the machine is a day, a total per model
  family, and nothing else. The raw file is never uploaded, sampled, or hashed.
- **A count it cannot find is not estimated.** Same rule as the extension.

**[decide]** Whether the reporter is a separate CLI, or a Claude Code plugin.
The CLI is recommended: it works regardless of how the user launches Claude
Code, and a plugin cannot read history from before it was installed.

---

## 4. What gets ranked

"Total tokens" is the obvious metric and the wrong one. Cache reads are an
order of magnitude cheaper than input tokens, so ranking on a raw sum rewards
whoever has the most cache-heavy workflow rather than whoever did the most work.

**Recommended metric:** `input_tokens + output_tokens`, with
`cache_creation_input_tokens` counted and `cache_read_input_tokens` shown
separately rather than added. The board displays the breakdown, so the ranking
is legible rather than a mystery number.

Boards, all showing the top 100:

- **This week** (resets Monday 00:00 UTC) — the one the bot posts
- **This month**
- **All time**

Each row: rank, display name, output tokens, input tokens, cache reads,
sessions, and the day the person last submitted.

**On honesty:** these numbers are self-reported by software running on the
user's machine, and there is no way to verify them. Anyone determined to fake a
number can. The mitigations are a per-day submission cap, a sanity ceiling that
flags absurd values for review, and — most importantly — **labelling the board
"self-reported" on the page itself**. A leaderboard that implies audit it does
not have is the kind of confident wrong number `AGENTS.md` rules out
everywhere else.

---

## 5. Identity

No accounts, no email, no password — the relay already has an identity model
and it is the right one: **possession of a token, bound to a Telegram chat.**

1. `/start` to the bot → an 8-character code, 10-minute TTL (this already
   exists in the design).
2. `wick-cc login <code>` exchanges it for a token, stored in
   `~/.config/wick/credentials` with `0600`.
3. `wick-cc optin` creates the leaderboard row with an assigned name.

Display name is **assigned, not taken** (ADR 0007). Defaulting to the Telegram
username would publish an identifier the user gave the bot for delivery, not
for display — a different purpose, and not one they agreed to. Assign from the
committed word list; changing it is the paid rename, and it is the only thing
the project sells.

The same token authenticates alerts and submissions, which keeps one credential
per installation and one revoke path.

---

## 6. The relay, extended

Three new endpoints alongside the four in ADR 0003. Same `Authorization:
Bearer` model, same versioning.

```
POST /v1/leaderboard/optin     { name }                  → 200 { id }
POST /v1/leaderboard/submit    { date, tokens: {...} }   → 202 {}
POST /v1/leaderboard/optout    {}                        → 204
GET  /v1/leaderboard/top       ?board=week|month|all     → 200 { rows }   (public, cached)
```

`submit` is **idempotent per (token, date)**: re-submitting a day replaces it
rather than adding to it. The reporter is allowed to re-run, and a retry must
never inflate a total.

### 6.1 Storage — a third table

```sql
CREATE TABLE leaderboard (
  token_hash    TEXT NOT NULL,   -- joins to connections; the identity
  display_name  TEXT NOT NULL,   -- chosen, not taken
  day           TEXT NOT NULL,   -- YYYY-MM-DD, local to the reporter
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read    INTEGER NOT NULL,
  cache_write   INTEGER NOT NULL,
  sessions      INTEGER NOT NULL,
  PRIMARY KEY (token_hash, day)
);
```

Notably still absent, and each ruled out for the same reasons as in ADR 0003:
no project names, no repository names, no file paths, no prompt or response
content, no per-session rows, no timestamps finer than the day, no IP
addresses, no Claude account or organisation id.

The day-granularity rule from ADR 0003 carries over intact: a table with a
`submitted_at` column is a record of when this person works.

### 6.2 Logging

Per the 2026-08-25 amendment to ADR 0003: the platform's own request log is
accepted, kept at the platform's minimum retention, and never drained or
exported. The relay's own code still writes aggregate counters only — no bodies,
no token hashes, no chat ids, no message text.

The leaderboard adds a table, not a licence to log. Submissions carry a day and
four integers; a per-request application log of them would be a usage stream,
which is the thing the table's day-granularity design exists to avoid.

---

## 7. Telegram surface

Bot commands, served by the same deployment as the API:

| Command | Does |
|---|---|
| `/start` | Issue a connect code (exists) |
| `/leaderboard` | Post this week's top 10 |
| `/me` | Your rank, your totals, and how far behind the person above |
| `/optin`, `/optout` | Join or leave the board |
| `/forget` | Delete everything, now including leaderboard rows (exists, extended) |

**[decide]** A weekly digest post — top 10 to every opted-in chat when the week
rolls over. It is the feature most likely to make the board fun and the one most
likely to get the bot muted. Recommendation: build it **off by default**, opt in
with `/digest on`.

One operational note carried over from §"Rate limiting" in ADR 0003: if the
weekly roll fires for every user at the same instant, Telegram's ~30
messages/second ceiling turns a 20,000-user digest into an eleven-minute drain.
Jitter the sends across the first hour, or send only to chats that asked.

---

## 8. The page — usewick.lol

A single server-rendered page from the same deployment: the three boards, the
breakdown columns, a "self-reported" label, and a link to the source. Cached at
the edge for 60 seconds so a viral moment costs one query per minute rather
than one per viewer.

No client-side framework, no analytics, no fonts from a third party — the same
rules the extension follows. It is a table; it does not need 200 kB of
JavaScript to be one.

**[decide]** Whether the extension links to it. Recommendation: one link in
settings, under Project, next to the repository link. Not in the panel — the
panel is about the user's own limits, and a leaderboard in it is an
advertisement in someone else's sidebar.

---

## 9. Capacity, on the free tier

Per active install, per day, from the design in ADR 0003 plus §6:

| Traffic | Volume |
|---|---|
| Alerts (`/v1/send`), with session-reset pings on by default | ~5/day |
| Leaderboard `submit` | 1/day |
| D1/Postgres writes | ~2/day (submission, `last_used_on`) |
| Page views | cached 60s at the edge — independent of user count |

So **~6 requests per install per day**.

### Cloudflare Workers + D1

| Limit | Free tier | Installs |
|---|---|---|
| Worker requests | 100,000/day | **~16,000** ← binding |
| D1 row writes | 100,000/day | ~50,000 |
| D1 row reads | 5,000,000/day | ~800,000 |

### Vercel Hobby + Neon

| Limit | Free tier | Installs |
|---|---|---|
| Function invocations | 1,000,000/month (~33k/day) | ~5,500 |
| Function CPU | 4 CPU-hours/month | **~4,000** ← binding, at a guessed 20 ms/request |
| Neon rows | generous on its own free tier | not binding |

The CPU-hours line is the one to check before committing: it is an estimate
against a number nobody has measured for this code, and it is the limit that
binds. If the real figure is 5 ms rather than 20, Vercel's ceiling is four times
what this table says.

**Beyond the free tier**, either way, the cost is trivial: Workers paid is $5 a
month for 10M requests, which at ~6/install/day is roughly 55,000 installs. This
runs out of "I want to operate this" long before it runs out of money.

Telegram is not the constraint at any of these numbers — ~30 messages/second to
distinct chats is about 2.6M/day — but see §7 on the weekly digest, where the
constraint is the burst rather than the total.

---

## 10. Order of work

| Phase | What | Depends on |
|---|---|---|
| **0** | Pin the origin to `relay.usewick.lol`, five files | nothing |
| **0.5** | Choose the host (§2.1) and set the two logging checklist items ADR 0003's amendment now depends on: retention at minimum, no log drain | nothing |
| **1** | Deploy the relay as designed in ADR 0003 — alerts only, no leaderboard | 0, 0.5 |
| **2** | ADR 0005 and ADR 0006; rewrite `PRIVACY.md` | owner decisions in §1 |
| **3** | `wick-cc` reporter: read JSONL, aggregate, `login`, `optin`, `submit` | 2 |
| **4** | Relay leaderboard endpoints and table | 2 |
| **5** | Bot commands | 4 |
| **6** | The page | 4 |
| **7** | Weekly digest, if §7 is decided that way | 5 |

Phases 0 and 1 are worth doing whatever happens to the rest: they finish a
feature that is already built and currently cannot ship.

---

## 11. Explicitly not in this plan

- **Token estimation of any kind.** ADR 0001 stands except for counts read from
  a first-party record.
- **Anything about claude.ai usage on the leaderboard.** The extension's
  percentages stay local. Ranking those would mean publishing how close a named
  person is to being cut off, which is nobody's business, and mixing two
  incomparable metrics on one board.
- **Per-project or per-repository breakdowns.** The interesting version of this
  feature is also the one that publishes what people are working on.
- **Cost estimates in currency.** That needs a pricing table per model, which is
  exactly the per-feature cost table ADR 0001 refused.
- **Verification of submitted numbers.** Not possible; the board says so instead
  of pretending otherwise.
- **A log drain, or any export of the platform's request log.** The 2026-08-25
  amendment accepts a short-lived log the host keeps on its own. Forwarding that
  anywhere turns an hour into an archive, and it is a separate decision that has
  not been made.

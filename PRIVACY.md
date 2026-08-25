# Privacy

Short version: Wick keeps browser usage data on your machine. Two optional
features send data elsewhere only after you set them up: Telegram alerts send
the alert you configured, and the separate `wick-cc` reporter sends aggregate
Claude Code token totals after you opt into the public leaderboard.

## Browser extension data

The extension stores these values in `chrome.storage.local`, in your browser
profile:

- **Current snapshot** — the latest percentage, status, and reset time for each
  limit window.
- **Daily history** — the date, peak percentage per window, and a message count,
  used for the burn-rate projection.
- **Settings** — display and alert preferences and, if you set up alerts, the
  Telegram bot token you created, the chat id it sends to, and a display label.

It does not store conversation content, prompts, responses, or titles. By
default it makes no network request other than to claude.ai: there is no
analytics, telemetry, crash reporting, usage reporting, or phone-home on install
or update.

## Optional Telegram alerts

If you connect Telegram, the extension sends an alert when a threshold or reset
you configured occurs. The alert contains the percentage, pace, and projected
exhaustion time shown locally. It contains no prompt, response, or project data.

**Alerts go straight from your browser to `https://api.telegram.org`. There is
no Wick server in the path, and no operator who can see that you received an
alert or when.**

This works because you create the bot yourself with @BotFather, and Wick stores
that token in `chrome.storage.local`. Being straightforward about what that
means: **extension storage is plain JSON on disk, not a vault.** Any program
running as you can read it. Two things bound what that costs you — the bot is
yours and talks to nobody but you, and anything able to read that file can
already read your claude.ai session cookies sitting beside it. You can revoke
the token at any time in @BotFather, which stops it working everywhere, not just
here. See
ADR 0009.

Wick reads Telegram twice. Once during setup, to learn which chat to send to —
you are never asked to look up a chat id. And once per polling tick, so the bot
can answer `/weekly` and `/daily` without a server. **It only ever replies to
the chat you connected**; a bot username is public, and a message from anyone
else is read and discarded rather than answered.

The Telegram origin is an optional Chrome host permission requested only from
the Connect button. Declining or revoking it blocks alerts without affecting
collection, projections, the toolbar icon, or local notifications.

## Optional Claude Code leaderboard

The leaderboard is a separate opt-in feature provided by the standalone
`wick-cc` command-line reporter. Installing or logging into that reporter does
not enable submissions; `wick-cc optin` is required.

The reporter reads Claude Code's local JSONL transcripts but accepts only the
record type and timestamp, message ID/role/model, and the four first-party API
usage counters. It uses those fields to validate, deduplicate, date, and
aggregate locally. It does not read for product use or transmit prompts,
responses, tool calls, working directories, project/repository names, or file
paths. Missing counts are skipped, never estimated.

A submission contains one local calendar day, one daily session count, and
bounded per-model-family totals for input, output, cache creation, and cache read
tokens. The relay sums the families and stores only:

- the submitting token's SHA-256 hash and the Telegram-chat-scoped profile;
- the chosen public display name;
- the day;
- aggregate input, output, cache creation, cache read, and session totals;
- whether the user explicitly enabled the weekly digest;
- day/week-granularity state needed to avoid duplicate digests.

It does not store family/model IDs, message IDs, project or repository names,
paths, prompts, responses, per-session rows, Claude account or organisation IDs,
or a submission timestamp. Re-submitting the same token and day replaces the
row rather than adding to it.

The public page at `https://usewick.lol` publishes the chosen display
name and aggregate week, month, or all-time totals and last submitted day. It
labels every board **self-reported** because the figures cannot be independently
verified. The page has no analytics, cookies, client-side application, or
third-party assets and is cached for 60 seconds.

The weekly Telegram leaderboard digest is off by default and is sent only after
`/digest on`.

See
ADR 0005
and ADR 0006.

## Hosting logs

Cloudflare keeps a platform request log under its account policy. It can include
a timestamp, route, status, user agent, and client IP. Retention must be set to
the shortest available period, and Wick configures no log drain, export, or
third-party error tracker. Application code logs no request bodies, alert text,
submission values, tokens or hashes, or Telegram chat IDs.

A reporter retry or changed same-day total can create more than one short-lived
platform log entry even though D1 keeps only one logical daily value. Anyone who
does not accept that should leave Telegram disconnected and not opt into the
leaderboard; all extension tracking remains local.

Telegram separately stores bot messages under Telegram's policies. Bot chats
are not end-to-end encrypted.

## What the extension reads from claude.ai

- The `lastActiveOrg` cookie, used only to identify which organisation's limits
  to show. Wick does not read your session cookie.
- The usage endpoint, which returns current limit percentages.
- The tail of completion responses, where claude.ai reports limit state. Wick
  extracts that event and discards the rest.

Required host access is restricted to `https://claude.ai/*`. The optional Telegram
origin is the only other host the extension can be granted.

## Deleting data

- Removing the extension deletes its local browser storage.
- Disconnect forgets the bot token and chat id locally. It does not revoke the
  bot — only @BotFather can do that, and doing so is worth it if you think the
  token leaked.
- The leaderboard is a separate, optional program with its own connection.
  Removing the extension does not delete anything you submitted to it.
- `wick-cc optout` or Telegram `/optout` deletes the public profile and all
  leaderboard rows while retaining alert connections.
- `wick-cc forget`, authenticated `POST /v1/delete`, or Telegram `/forget`
  deletes all connections, unredeemed codes, leaderboard rows/profile, and
  pending digest state for that Telegram chat.

Alerts leave no server-side trace to delete: they go straight to Telegram, and
no Wick server is in the path. The leaderboard's platform request logs expire on
its host's retention schedule and are not removed by these application-level
deletion operations.

## Verifying this

The extension, relay, and reporter are AGPL-3.0-or-later. Their source and D1
schema are the specification: if this policy and the running code disagree, the
code is the truth and the disagreement is a bug worth reporting.

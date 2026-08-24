# Privacy

Short version: Wick keeps your usage data on your own machine, and sends nothing
anywhere unless you explicitly set up an alert channel.

## What Wick stores, and where

Everything is in `chrome.storage.local`, in your browser profile, on your
computer:

- **Current snapshot** — the latest percentage, status and reset time for each
  limit window.
- **Daily history** — one small record per day: the date, the peak percentage
  reached in each window, and a message count. This is what the burn-rate
  projection reads.
- **Settings** — your alert thresholds and display preferences.

That is the whole list. Wick does not store conversation content, prompts,
responses, titles, or anything you type into Claude. It has no interest in them
and does not read them.

## What Wick sends

**By default: nothing.** There is no analytics, no telemetry, no crash
reporting, no usage statistics, and no phone-home on install or update. No
server learns that you installed this extension.

**If you connect Telegram alerts:** a message goes out when a threshold you
configured is crossed. It contains your usage percentage, your pace, and the
projected exhaustion time — the same numbers shown in the panel. It contains
nothing about what you were doing in Claude.

Alerts route through a relay service rather than posting to Telegram directly
from your browser, because the alternative means storing a Telegram bot token in
extension storage, which is trivially extractable. Your installation holds a
per-user token you can revoke; it never holds a bot credential. See
[`docs/decisions/0002-telegram-relay-not-bot-token.md`](docs/decisions/0002-telegram-relay-not-bot-token.md).

The relay is not built yet. When it is, this file will say exactly what it
stores and how to delete it.

## What Wick reads from claude.ai

- The `lastActiveOrg` cookie, to know which organisation's limits to show. Only
  this cookie, only on claude.ai. Wick does not read your session cookie and
  cannot authenticate as you outside your own browser.
- The usage endpoint, which returns your current limit percentages.
- The tail of completion responses, where claude.ai reports updated limit state.
  Wick looks for the limit event and discards the rest — it does not retain,
  log, or transmit message content.

Host access is restricted to `https://claude.ai/*`. Wick cannot see any other
site you visit.

## Deleting your data

Removing the extension from Chrome deletes its local storage, which is all of
it.

## Verifying this

Wick is AGPL-3.0-or-later. The source is the specification: if this file and the
code ever disagree, the code is the truth and the disagreement is a bug worth
reporting.

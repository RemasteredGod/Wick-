# Privacy

Short version: Wick keeps your browser usage data on your machine. One optional
feature sends anything elsewhere — the public leaderboard, which publishes a
daily message count under an assigned name after you press Join.

## Browser extension data

The extension stores these values in `chrome.storage.local`, in your browser
profile:

- **Current snapshot** — the latest percentage, status, and reset time for each
  limit window.
- **Daily history** — the date, peak percentage per window, a message count, and
  an hourly breakdown of that count, used for the burn-rate projection and the
  panel's statistics.
- **Settings** — display and alert preferences and, if you joined the
  leaderboard, the participant token the board issued, the name it assigned, and
  the last day already published.

It does not store conversation content, prompts, responses, or titles. By
default it makes no network request other than to claude.ai: there is no
analytics, telemetry, crash reporting, usage reporting, or phone-home on install
or update.

## Alerts

Threshold and reset alerts are Chrome notifications, raised locally by the
extension. **They involve no network request, no server, no account, and no
credential**, and they cannot be read by anyone but you.

There is no longer a Telegram alert channel. Earlier versions offered one, using
a bot token you created and pasted; it has been removed, along with the
`api.telegram.org` host permission it needed. If you set one up under a previous
version, the token is no longer read, and removing the extension deletes it
along with everything else in local storage.

## Optional leaderboard

The board is off until you press Join in settings. Nothing about it leaves your
machine before that.

**Joining** asks `https://www.usewick.lol` for a participant token and a name.
The request carries an empty body: no email, no handle, no account id, nothing
from claude.ai. The board assigns your name from a fixed word list — it is not
derived from anything about you, and nothing on the board is joined to your
Claude identity. Because the token is the only thing identifying you, there is
no way to recover it if you lose it and no way for anyone, including the
operator, to work out whose profile is whose.

**Each day**, the extension publishes one row: a calendar date and how many
messages you sent on it. That is the entire submission. It does not send
percentages, window names, reset times, the hourly breakdown, your organisation
id, model names, project names, prompts, or responses. Only settled days are
sent — today is never published, because it is still accumulating.

The server stores, per participant:

- the SHA-256 hash of the participant token — never the token itself;
- the assigned name, and its confusable-folded form;
- the date each profile was created, to day granularity;
- one row per calendar day: the day and the message count.

It does not store a submission timestamp, an IP address, an account or
organisation id, or anything finer than a calendar day. Re-submitting the same
day replaces the row rather than adding to it.

The public pages at `https://usewick.lol` — the board at `/board` and each
profile at `/u/<name>` — publish the assigned name, the message totals for the
week, month, and all time, the number of days behind each total, and the last
day submitted. Every board is labelled **self-reported**, because these figures
come from software on each participant's own machine and cannot be verified. The
pages have no analytics, cookies, client-side application, or third-party
assets, and are cached for 60 seconds.

The board origin is an optional Chrome host permission, requested only from the
Join button. Declining or revoking it blocks the board without affecting
collection, projections, the toolbar icon, or notifications.

## Hosting logs

Vercel keeps a platform request log under its account policy. It can include a
timestamp, route, status, user agent, and client IP. Retention is set to the
shortest available period, and Wick configures no log drain, export, or
third-party error tracker. Application code logs no request bodies, submission
values, tokens, or hashes.

For the length of that retention window, the host's own log records that
*someone* published a day, from which IP — not who, since the token never
appears in a URL. Anyone who does not accept that should not join the board; all
extension tracking remains local either way.

## What the extension reads from claude.ai

- The `lastActiveOrg` cookie, used only to identify which organisation's limits
  to show. Wick does not read your session cookie.
- The usage endpoint, which returns current limit percentages.
- The tail of completion responses, where claude.ai reports limit state. Wick
  extracts that event and discards the rest.

Required host access is restricted to `https://claude.ai/*`. The optional board
origin is the only other host the extension can be granted.

## Deleting data

- Removing the extension deletes its local browser storage.
- **Leave**, in settings, deletes your profile and every day you published, then
  forgets the token locally. There is no tombstone and no soft delete: the name
  returns to the pool and nothing is kept to show you were there. If the board
  cannot be reached, nothing is cleared locally either, so you can try again.
- Removing the extension without pressing Leave first leaves your published rows
  on the board with no way to reach them — the token was the only thing that
  could. Leave first.
- The board's platform request logs expire on the host's retention schedule and
  are not removed by these application-level deletions.

## Verifying this

The extension and the server are AGPL-3.0-or-later. Their source and
`supabase/schema.sql` are the specification: if this policy and the running code
disagree, the code is the truth and the disagreement is a bug worth reporting.

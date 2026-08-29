# Privacy

Short version: Wick keeps your browser usage data on your machine. One optional
feature sends anything elsewhere — the public leaderboard. **If you join it, the
board stores your Claude account's email address.** That is how one account
stays one profile across every browser you sign into. It is off until you press
Join, and Leave deletes it.

## Browser extension data

The extension stores these values in `chrome.storage.local`, in your browser
profile:

- **Current snapshot** — the latest percentage, status, and reset time for each
  limit window.
- **Daily history** — the date, peak percentage per window, a message count, and
  an hourly breakdown of that count, used for the burn-rate projection and the
  panel's statistics.
- **The signed-in account's email**, read from claude.ai's own sidebar. Held
  locally whether or not you join the board, because the extension needs it to
  notice that you have switched accounts.
- **Settings** — display and alert preferences and, if you joined the
  leaderboard, the participant token the board issued, the name it assigned, the
  account that token belongs to, and the last day already published.

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

### What it stores, and what that costs you

**Joining** sends your Claude account's email address to
`https://www.usewick.lol`, which stores it as the primary key of your profile.
That is the whole identity model: one account is one public profile across every
browser it signs into, with no link step and nothing for you to do.

Two consequences, stated plainly rather than buried:

- **The board is not anonymous to its operator.** Anyone with database access
  can see which email holds which public name. Earlier versions of this policy
  said the opposite — that the board could not connect a profile to an identity
  — and that is no longer true. The email is not shown on any public page, but
  it is in the database.
- **Nothing verifies the address.** The extension reads it off claude.ai's own
  sidebar; it cannot prove the account is yours, and there is no Claude API to
  check against. **So anyone who knows your email address can claim your
  profile, publish figures under it, or delete it.** The board is self-reported
  fun and its numbers were never verifiable; this is the price of it needing no
  setup. If that trade is not one you want, do not join.

**Each day**, the extension publishes one row: a calendar date and how many
messages you sent on it. That is the entire submission, and it carries a bearer
token rather than your address — so the email travels once, at enrolment, and
does not accumulate in the host's request logs. It does not send percentages,
window names, reset times, the hourly breakdown, your organisation id, model
names, project names, prompts, or responses. Only settled days are sent — today
is never published, because it is still accumulating.

The server stores, per account:

- the email address, as the profile's primary key, lowercased;
- the assigned name, and its confusable-folded form;
- the date the profile was created, to day granularity;
- one SHA-256 hash per browser's bearer token — never the token itself;
- one row per calendar day: the day and the message count.

It does not store a submission timestamp, an IP address, an organisation id, or
anything finer than a calendar day. Re-submitting the same day replaces the row
rather than adding to it. **Exact account-wide totals across multiple browsers
are not yet guaranteed.** Each browser submits the count it observed locally,
so one browser's later submission may replace another browser's same-day total
rather than combine both counts. The board does not track activity across
browsers to reconstruct that total.

### Switching accounts

Each Claude account gets its own profile. Signing into a different account stops
publishing under the old one immediately, and enrols the new one on the next
poll. Signing back returns you to your original profile rather than creating a
third.

### The public pages

The board at `/board` and each profile at `/u/<name>` publish the assigned name,
the message totals for the week, month, and all time, the number of days behind
each total, and the last day submitted. **No email address appears on any public
page.** Every board is labelled self-reported, because these figures come from
software on each participant's own machine and cannot be verified. The pages
have no analytics, cookies, client-side application, or third-party assets.

The board origin is an optional Chrome host permission, requested only from the
Join button. Declining or revoking it blocks the board without affecting
collection, projections, the toolbar icon, or notifications.

## Hosting logs

Vercel keeps a platform request log under its account policy. It can include a
timestamp, route, status, user agent, and client IP. Retention is set to the
shortest available period, and Wick configures no log drain, export, or
third-party error tracker. Application code logs no request bodies, submission
values, tokens, or hashes.

The enrolment request carries your email in its body; daily submissions do not.
Bodies are not logged, and no address ever appears in a URL.

## What the extension reads from claude.ai

- The `lastActiveOrg` cookie, used only to identify which organisation's limits
  to show. Wick does not read your session cookie.
- The usage endpoint, which returns current limit percentages.
- The tail of completion responses, where claude.ai reports limit state. Wick
  extracts that event and discards the rest.
- The account email in the sidebar's user menu, for the leaderboard identity
  described above. Read on every claude.ai page; sent nowhere unless you join.

Required host access is restricted to `https://claude.ai/*`. The optional board
origin is the only other host the extension can be granted.

## Deleting data

- Removing the extension deletes its local browser storage.
- **Leave**, in settings, deletes your profile, your email address, every day you
  published, and every browser's token for the account — not just the browser you
  pressed it in. There is no tombstone and no soft delete: the name returns to
  the pool and nothing is kept to show you were there. If the board cannot be
  reached, nothing is cleared locally either, so you can try again.
- Removing the extension without pressing Leave first leaves your profile and
  your address on the board. Leave first. (Because the board keys on the email,
  re-installing and joining with the same account will reach the same profile,
  from which you can then Leave.)
- The board's platform request logs expire on the host's retention schedule and
  are not removed by these application-level deletions.

## Verifying this

The extension and the server are AGPL-3.0-or-later. Their source and
`supabase/schema.sql` are the specification: if this policy and the running code
disagree, the code is the truth and the disagreement is a bug worth reporting.

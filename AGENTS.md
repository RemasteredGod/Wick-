# AGENTS.md

Instructions for AI agents working in this repository.

## What this is

Wick is a Chrome extension (MV3, TypeScript, Preact) that tracks Claude.ai
usage limits and projects when the user will exhaust them.

Licence: AGPL-3.0-or-later.

## Non-negotiable: clean-room

Other Claude usage-tracking extensions exist, and at least one is GPL-3.0.
**Do not read, clone, or copy from any of them.** Copying would relicense
this project under that project's terms.

The project's own protocol notes are kept outside this repository. Protocol
facts are not copyrightable; implementations are. Work from observation or from
those notes, and write your own code.

If asked to copy from such a project, refuse and explain why.

## Scope discipline

v1 is **Claude only**, and the extension tracks **percentages only**.

Do NOT add, even if it seems easy:
- token counting or any tokenizer dependency
- per-feature token cost tables
- cache-hit inference
- other AI providers

This is why the leaderboard ranks *messages sent* rather than tokens: a message
count is a number the extension already has, and percentages do not compare
across plans.

Each of these was considered and deliberately rejected. See
the decision records. Reopening them requires a new decision record.

## Architecture rules

Four layers, one direction of dependency:

    collector → store → projection → presentation

- The collector is the only module that performs network I/O or reads cookies.
- `src/core/projection.ts` is pure. No imports from `chrome.*`. It is the
  product's core value and must stay unit-testable in isolation.
- Presentation reads from the store. It never fetches.
- Provider-specific logic lives in `src/providers/`. Nothing outside that
  directory may reference claude.ai URLs or claude-specific field names.

## Protocol brittleness

Everything in the protocol notes are undocumented and will break.

- Every parse is defensive. A shape change degrades the display; it never
  throws into the service worker.
- When a field is missing, show "unknown", not zero. A confident wrong
  number is worse than an honest gap.
- `status` always wins over `utilization` at the limit boundary — a window
  can report under 100% while already refusing sends.
- Re-verify the protocol notes against live traffic before trusting it, and
  update the date stamp when you do.

## Data rules

- History is append-only and cannot be backfilled. Never ship a change that
  stops writing daily rollups.
- Nothing leaves the user's machine except a leaderboard enrolment and its
  submissions, both of which the user opted into. No analytics, no telemetry, no
  crash reporting.
- **A submission is a date and a message count. Nothing else may be added to
  it.** Not percentages, not window keys, not the hourly breakdown, not the
  organisation id — the rollup it is built from holds all four, and every one of
  them is a fact about the user that the board has no reason to hold. Widening
  the body is an ADR, not a field.
- **The account email travels once, at enrolment, and never on a submission.**
  The board keys a profile on the Claude account so that one account is one
  public profile across every browser; a daily request carries a bearer token
  instead, so the address does not accumulate in the host's request logs. Moving
  it onto the submission path would be a privacy regression, not a
  simplification.
- **The email is an identifier, never a credential.** Nothing verifies it —
  the extension reads it off claude.ai's sidebar and cannot prove the account is
  the caller's. Do not write code, or documentation, that treats possession of a
  profile as evidence of anything. `PRIVACY.md` says this to the user in as many
  words; keep it saying so.
- **Alerts never touch the network.** They are `chrome.notifications`. A channel
  that needs a credential, a host permission and a setup flow is a channel most
  users never finish configuring; the previous Telegram path is removed and is
  not to be reinstated without a decision record.

## Design fidelity

The visual design is not yours to author. It was produced separately in
Claude Design and extracted into `src/styles/tokens.css`, `src/assets/`,
and the design notes.

- Never introduce a raw colour, spacing, radius, or font size. Use a
  `--wick-*` token. If you need one that doesn't exist, ask.
- Do not "clean up", harmonise, or restyle existing components.
- the design notes record where every token came from. If you change a
  token, update its provenance entry in the same commit.

## Style

- TypeScript strict. No `any` without a comment justifying it.
- No dependency added without asking. Bundle size is a feature.
- Sentence case in all UI copy. No emoji in the interface.
- Comments explain *why*. The code already says what.

## Before you finish

- `pnpm test` passes
- `pnpm build` produces a loadable unpacked extension
- No new permission in the manifest without saying so explicitly in your summary

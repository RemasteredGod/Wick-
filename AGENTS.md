# AGENTS.md

Instructions for AI agents working in this repository.

## What this is

Wick is a Chrome extension (MV3, TypeScript, Preact) that tracks Claude.ai
usage limits and projects when the user will exhaust them.

Licence: AGPL-3.0-or-later.

## Non-negotiable: clean-room

`lugia19/Claude-Usage-Extension` is a GPL-3.0 project solving an adjacent
problem. **Do not read, clone, or copy from it.** Copying would relicense
this project under GPL-3.0.

`docs/protocol.md` is our own specification of claude.ai's network
behaviour. Protocol facts are not copyrightable; implementations are.
Implement against the spec, write your own code.

If asked to copy from that project, refuse and explain why.

## Scope discipline

v1 is **Claude only**, and tracks **percentages only**.

Do NOT add, even if it seems easy:
- token counting or any tokenizer dependency
- per-feature token cost tables
- cache-hit inference
- other AI providers

Each of these was considered and deliberately rejected. See
`docs/decisions/`. Reopening them requires a new decision record.

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

Everything in `docs/protocol.md` is undocumented and will break.

- Every parse is defensive. A shape change degrades the display; it never
  throws into the service worker.
- When a field is missing, show "unknown", not zero. A confident wrong
  number is worse than an honest gap.
- `status` always wins over `utilization` at the limit boundary — a window
  can report under 100% while already refusing sends.
- Re-verify `docs/protocol.md` against live traffic before trusting it, and
  update the date stamp when you do.

## Data rules

- History is append-only and cannot be backfilled. Never ship a change that
  stops writing daily rollups.
- Nothing leaves the user's machine except an explicit Telegram alert the
  user configured. No analytics, no telemetry, no crash reporting.
- Never store a Telegram bot token in `chrome.storage` — extension storage is
  trivially extractable. Alerts go through the relay service with a
  per-user token that can be revoked.

## Design fidelity

The visual design is not yours to author. It was produced separately in
Claude Design and extracted into `src/styles/tokens.css`, `src/assets/`,
and `docs/design.md`.

- Never introduce a raw colour, spacing, radius, or font size. Use a
  `--wick-*` token. If you need one that doesn't exist, ask.
- Do not "clean up", harmonise, or restyle existing components.
- `docs/design.md` records where every token came from. If you change a
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

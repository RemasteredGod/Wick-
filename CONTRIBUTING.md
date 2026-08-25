# Contributing

Contributions welcome. A few things about this project are unusual, so please
read this before opening a pull request.

## The clean-room rule

**Do not read, clone, or copy from other Claude usage-tracking extensions.**

Several exist, and at least one is GPL-3.0. Wick is a clean-room
implementation: not a fork, and not a derivative work. Copying from one —
source, build scripts, manifest, file layout — would relicense Wick under that
project's terms and forfeit its own.

This applies to you as much as to any AI agent working here. If you have read
such a project's source, please say so on your pull request, so we can decide
whether the overlapping area needs to be written by someone who has not.

What *is* fine: facts about claude.ai's network protocol. Endpoint paths, event
names and JSON field names are not copyrightable. Work them out from your own
observation of the traffic, or ask a maintainer for the project's protocol
notes, which are kept outside this repository. Do not work them out by reading
another implementation.

## Architecture

Four layers, one direction of dependency:

```
collector → store → projection → presentation
```

A change to how data is fetched must never require touching the interface.

- The collector is the only module that performs network I/O or reads cookies.
- `src/core/projection.ts` is pure — no `chrome.*` imports, no I/O. It is the
  product's core value and stays unit-testable in isolation.
- Presentation reads from the store. It never fetches.
- Provider-specific logic lives in `src/providers/`. Nothing outside that
  directory may reference claude.ai URLs or Claude-specific field names.

## Scope

v1 is Claude only, and tracks percentages only. Please do not add token
counting, tokenizer dependencies, per-feature cost tables, cache-hit inference,
or other providers. Each was considered and deliberately rejected — see
[the decision records](the decision records). Reopening one means writing a decision
record first, which is a welcome kind of pull request in itself.

## Design

The visual design was produced separately in Claude Design and extracted into
`src/styles/tokens.css`, `src/assets/`, and the design notes.
It is not ours to re-author on a whim.

- Never introduce a raw colour, spacing value, radius, or font size. Use a
  `--wick-*` token. If the token you need does not exist, open an issue rather
  than inventing one.
- Do not "clean up", harmonise, or restyle existing components.
- the design notes record where every token came from. Changing a token means
  updating its provenance entry in the same commit.
- The warn and crit colours are reserved for state. If they appear
  decoratively, the warning stops meaning anything.

## The protocol breaks constantly

Everything in the protocol notes are undocumented and will drift.

- Every parse is defensive. A shape change degrades the display; it never throws
  into the service worker.
- When a field is missing, show "unknown", not zero. A confident wrong number is
  worse than an honest gap.
- `status` wins over `utilization` at the boundary — a window can report under
  100% while already refusing sends.
- If you re-verify a section against live traffic, update its date stamp in the
  same commit.

## Code style

- TypeScript strict. No `any` without a comment justifying it.
- No new dependency without discussing it first. Bundle size is a feature.
- Sentence case in interface copy. No emoji in the interface.
- Comments explain *why*. The code already says what.

## Before you open a pull request

```sh
pnpm test     # passes
pnpm build    # produces a loadable unpacked extension
```

If your change adds a manifest permission, say so explicitly in the pull request
description and explain why it is needed. Every extra permission is a Web Store
review delay and a cost to user trust.

## Licence

By contributing you agree your work is licensed under AGPL-3.0-or-later.

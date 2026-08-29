# Contributing

Contributions are welcome. A few things about this project are unusual, so read
this before opening a pull request.

## The clean-room rule

**Do not read, clone, or copy from other Claude usage-tracking extensions.**

Several exist, and at least one has licence terms that must not be imported into
Wick. Wick is a clean-room implementation: not a fork and not a derivative
work. Do not copy source, tests, build scripts, manifest content, file layout,
documentation, screenshots, or generated output from another tracker.

If you have already read another tracker's implementation, disclose that before
working in the overlapping area so a maintainer can decide whether the work
needs a contributor who has not seen it. Do not paste third-party code into an
issue or pull request to explain the overlap.

Protocol facts such as endpoint paths, event names, and JSON field names may be
established from your own observation or from the maintainers' protocol notes,
which are kept outside this repository. Do not establish them by reading
another implementation. Record only redacted fixtures: never commit session
cookies, account emails, organisation identifiers, conversation content, or
captured credentials.

## Architecture and product scope

Dependencies flow in one direction:

```
collector → store → projection → presentation
```

- The collector is the only module that performs network I/O or reads cookies.
- `src/core/projection.ts` is pure: no `chrome.*` imports and no I/O.
- Presentation reads from the store and never fetches.
- Provider-specific URLs and fields stay in `src/providers/`.

v1 is Claude only and tracks percentages only. Do not add token counting,
tokenizer dependencies, per-feature cost tables, cache-hit inference, or other
providers. These standing constraints are recorded in [`AGENTS.md`](AGENTS.md);
reopening one requires an owner-reviewed decision record.

History is append-only and cannot be backfilled. Preserve daily rollups. A
leaderboard submission is exactly a date and message count, and the account
email travels only at enrolment. Alerts are local Chrome notifications and must
not gain a network path.

## Design and code style

The visual design was produced separately and extracted into the tracked
`src/styles/tokens.css` and `src/assets/` sources. Follow the design-fidelity
rules in [`AGENTS.md`](AGENTS.md) and do not restyle it opportunistically.

- Use a `--wick-*` token for every colour, spacing, radius, and font size. Open
  an issue if the required token does not exist.
- Update a changed token's provenance entry in the same change.
- Keep warning and critical colours reserved for state.
- Use strict TypeScript. `any` requires a comment explaining why it is needed.
- Discuss every new dependency first; bundle size is a feature.
- Use sentence case and no emoji in interface copy.
- Comments explain why rather than repeating the code.

All undocumented protocol parsing must be defensive. Missing data displays as
“unknown”, never zero; parser drift must degrade the display rather than throw
into the service worker; and `status` wins over `utilization` at a limit
boundary. When live traffic is re-verified, update its date stamp and evidence.

## Validation

Use Node 24 and the pnpm version pinned in `package.json`. Start from a
clean install:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm verify:build
```

Run focused tests while developing, then the full commands above before opening
a pull request. A build is not sufficient by itself: load `dist/` as an
unpacked extension when behavior affects Chrome, and inspect the service worker,
content scripts, popup, permissions, icons, and notifications relevant to the
change. Never use a personal or production account for fixtures when an invented
`.invalid` account can exercise the path.

Release or packaging changes must also run `pnpm package` and
`pnpm verify:package`, prove two equivalent clean builds are byte-identical, and
compare SHA-256 hashes. Hosted Supabase, Vercel, WAF, cache, rate-limit, and
Chrome Web Store checks are manual evidence; repository tests cannot claim they
passed. See [`RELEASING.md`](RELEASING.md).

In the pull request, list tests run and any check that could not be run. Call out
all dependency, manifest permission, privacy/data-flow, protocol, schema,
migration, and deployment changes explicitly. Never treat a local pass as
production authorisation.

## Security reports

Do not put exploit details, credentials, personal data, or proofs of concept
against a deployed service in a public issue or pull request. Follow
[`SECURITY.md`](SECURITY.md) and use the repository's
[private vulnerability report](https://github.com/RemasteredGod/Wick-/security/advisories/new).
Use placeholder accounts and redact emails, organisation IDs, bearer tokens,
Supabase keys, request bodies, and conversation content.

A confirmed product defect also follows the repository's issue/bug tracking
process, but exploitable details remain private until a fix is available.

## Pull requests and licence

Keep changes focused and explain user-visible behavior and why it is needed. If
a change adds a manifest permission, say so explicitly and explain why; every
permission increases Web Store review time and user-trust cost. Do not commit
build artifacts unless the repository explicitly tracks them.

By contributing, you agree your work is licensed under
[AGPL-3.0-or-later](LICENSE).

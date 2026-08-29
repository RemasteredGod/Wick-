# Changelog

All notable changes to Wick are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses the version in
`package.json` for extension releases.

## [Unreleased]

### Added

- Local percentage history, burn-rate projections, toolbar gauge, and browser
  notification alerts.
- An optional self-reported message-count leaderboard with enrol, submit,
  profile, board, and account-wide Leave flows.
- Defensive database preflight checks, ordered migrations, explicit privileges,
  and atomic profile-enrollment and profile-deletion functions.
- Deterministic extension packaging and verification, plus a release checklist
  with guarded GitHub draft review steps.

### Changed

- Updated extension and site identity to the owner-provided v3 upright mark, with
  deterministic unknown-state toolbar icons, dynamic usage/status action titles,
  and same-origin favicons.

- Leaderboard identity is keyed by the signed-in account email observed in the
  account sidebar; submissions still contain only a date and message count.
- Leaderboard access is an optional host permission requested only when the user
  chooses to join.
- Popup state reloads are latest-request-wins, so a delayed Leave read cannot
  overwrite a successful Join-again state.
- Vercel preview installs retain required TypeScript declarations under
  `NODE_ENV=production` and use pinned Node 24 and pnpm 10 tooling.
- Release status now distinguishes repository implementation from hosted,
  protocol, browser, and store-review gates.

### Security

- Leaderboard mutations reject unexpected request shapes and use bearer tokens;
  stored tokens are hashed.
- Public and mutation responses use explicit cache policy, while hosted WAF and
  rate-limit behavior remain a pre-release operational gate.

No public release is represented by this section. See [RELEASING.md](RELEASING.md)
for the manual gates that remain.

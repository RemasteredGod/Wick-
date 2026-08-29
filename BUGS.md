# Bug register

This is the concise release-blocker register. Each confirmed defect also gets a
GitHub issue; exploitable security details stay in a private advisory until a
fix is available.

Status values: `open`, `in progress`, `blocked`, `verified`, `deferred`.
Severity values: `critical`, `high`, `medium`, `low`.

## WICK-001 — Joined leaderboard does not visibly update

- Severity: high
- Status: blocked (implementation verified; staging day-rollover observation pending)
- Affected: current `leaderboard-foundations` build
- Report: Join succeeds and assigns a public name, but the website does not show
  the participant's message total.
- Evidence: the previous extension behavior excluded the current day, waited for
  a later poll to drain completed days, hid profiles with no ranked rows, and
  collapsed all submission failures into one silent result. The repair now
  drains completed backlog after enrolment/startup, batches old rows without an
  age cutoff, live-revalidates identity, serializes board operations, and stores
  privacy-safe sync state. Focused board/settings tests pass 64/64 and typecheck
  passes; an independent reviewer approved the implementation.
- Required fix: preserve completed-days-only publication, drain an existing
  completed backlog after enrolment/startup, expose privacy-safe local sync
  outcomes, and verify the full day-rollover path.
- Close with: extension-to-API-to-store-to-render integration test plus staging
  observation across a completed calendar day.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/9

## WICK-002 — Board cache can outlive the deletion promise

- Severity: high
- Status: blocked (implementation verified; staging cache/Leave observation pending)
- Affected: `api/board.ts`
- Evidence: the previous board response allowed five minutes of stale serving after
  its one-minute cache lifetime. Successful board responses now use exactly
  `public, s-maxage=60` with no stale-while-revalidate; profile responses are
  `no-store`. Handler tests and the independent backend audit verify the headers.
- Required fix: remove the stale serving window and verify the hosted edge does
  not serve a deleted participant beyond the documented minute.
- Close with: cache-header test and staging Leave observation.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/13

## WICK-003 — Unknown account observation can publish under a stale binding

- Severity: high
- Status: verified
- Affected: current `leaderboard-foundations` build
- Evidence: the previous publisher could rely on a stale cached observation when
  the account became unknown. The repair persists explicit nullable account
  transitions, requires live provider tabs to agree before publication, validates
  sender provenance, preserves the old Leave credential while paused, and reads
  public totals only from a normalized email-bound local ledger. Untrusted
  MAIN-world hints cannot write that ledger. Focused trust/store/board tests pass
  101/101; the full suite passes 570 tests; typecheck/build pass; independent
  review approved the implementation.
- Required fix: fail closed unless current identity is freshly confirmed where a
  provider tab is present, retain deletion credentials while paused, and prevent
  organisation-scoped legacy rows from becoming email-scoped submissions.
- Close with: account-null/switch, sender-forgery, ledger-isolation, and stale
  operation regression tests.
- GitHub issue: private tracking until the fixed release is available

## WICK-004 — Public write endpoints lack complete abuse bounds

- Severity: high
- Status: blocked (code bounds verified; WAF configuration/observation pending)
- Affected: enrolment and submission API
- Evidence: mutation routes are now POST-only, require bounded JSON bodies, bound
  authorization headers, reject malformed/oversized/unsupported requests safely,
  and accept only the documented 90-day date window plus conservative timezone
  skew. Public handlers have explicit method/Allow behavior and generic errors.
  Focused handler tests and independent review pass. Repository code cannot prove
  the production Vercel WAF or observed 429 behavior.
- Required fix: retain the code bounds, document/configure deployment-level rate
  limits, and verify safe hosted behavior without logging request secrets.
- Close with: abuse tests and a production-configuration checklist observation.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/14

## WICK-005 — Multi-browser daily totals overwrite rather than aggregate

- Severity: medium
- Status: deferred
- Affected: leaderboard storage model
- Evidence: `(email, day)` is one upsert row. Independent browser totals replace
  each other; they cannot converge to an account-wide sum from absolute counts.
- Mitigation: `PRIVACY.md` now states that exact account-wide totals across
  multiple browsers are not guaranteed, a later same-day browser submission may
  replace rather than combine another local total, and Wick does not track
  cross-browser activity to reconstruct it. Do not widen stored data without a
  privacy/decision review.
- Close with: accepted data-model amendment and multi-browser integration test.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/10

## WICK-006 — Production schema changes are not versioned migrations

- Severity: high
- Status: blocked (migration implementation verified; staging upgrade pending)
- Affected: Supabase deployment process
- Evidence: the repository now contains advisory-locked transactional migrations,
  exact legacy/current/ledger shape guards, a read-only preflight, explicit
  least-privilege ACL/RLS posture, an atomic hashed-token `forget_profile` RPC,
  and a production runbook. Static adapter/schema tests and independent review
  pass. No hosted PostgreSQL execution, backup restore, privilege probe, or
  migration has been performed.
- Required fix: rehearse the reviewed migrations against fresh, exact legacy,
  current, and malformed staging fixtures after proving a restorable backup.
  Any production migration or destructive reset requires explicit owner approval.
- Close with: staging upgrade test from the previous schema and hosted privilege,
  atomicity, concurrency, and restore evidence.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/11


## WICK-007 — Packaged extension icons were missing

- Severity: high
- Status: blocked (implementation verified; real Chrome/Windows smoke pending)
- Affected: extension manifest, toolbar action, and local notifications
- Evidence: the previous notification path referenced `icons/128.png` without a
  packaged icons directory, and the manifest declared no extension/action icons.
  Deterministic design-derived 16/32/48/128 PNGs, manifest/action mappings, the
  notification path, byte/dimension tests, and source/dist verification now pass.
  Focused icon tests pass 114/114; the full suite passes 629 tests; typecheck and
  build pass; independent pixel/provenance/package review approved the fix.
- Required fix: retain deterministic packaged assets and verify their appearance
  in an unpacked Chrome toolbar plus an actual Windows browser notification.
- Close with: automated package verification and owner-observed Chrome/Windows
  toolbar and notification smoke test.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/12

## WICK-008 — Enrollment profile and credential were not atomic

- Severity: medium
- Status: blocked (implementation verified; staging rollback/concurrency pending)
- Affected: Supabase enrollment persistence
- Evidence: the previous adapter created a profile and inserted its browser token
  in separate PostgREST requests, so a failed token insert could retain the
  account email/profile without returning a credential. Enrollment now uses one
  transactional `enroll_profile` RPC carrying only the token hash; exact schema,
  migration, ACL, conflict, and adapter tests pass.
- Mitigation: keep public launch blocked until isolated staging proves rollback
  on token failure, no partial data on name conflict, and concurrent same-email
  convergence. The extension remains pre-release and unverified protocol-based
  counting remains disabled.
- Close with: staging transaction, conflict, PostgREST, effective privilege, and
  concurrent first-enrollment observations.
- GitHub issue: https://github.com/RemasteredGod/Wick-/issues/15

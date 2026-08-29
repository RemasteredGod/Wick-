# Releasing Wick

This is a checklist for a future, explicitly authorised release. It is not
permission to inspect or change a hosted service, migrate production data,
create or push a Git tag, publish a GitHub Release, upload to the Chrome Web
Store, or start a rollout. Each hosted, Git, or publishing action needs the
repository owner's separate approval at that gate. Stop on missing,
contradictory, or unexpected evidence.

## 1. Freeze the candidate

- [ ] Identify the candidate commit and release owner; use a clean branch with no
  unreviewed or uncommitted files.
- [ ] Confirm the target version is unused and valid for Chrome, and that
  `package.json`, the built manifest, the changelog, and release notes agree.
  Never reuse or decrement a published extension version.
- [ ] Review the complete diff and dependency/permission changes. Confirm no new
  dependency or manifest permission is unexplained.
- [ ] Install with the pinned package manager and lockfile:
  `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and
  `pnpm verify:build`, then run `pnpm package` and `pnpm verify:package` for the
  candidate artifact.
- [ ] Require successful CI for the exact candidate commit. A local pass does not
  substitute for CI, and a workflow file does not prove that GitHub Actions ran.
- [ ] Confirm every critical/high finding in [`BUGS.md`](BUGS.md) is closed with
  its required test or observation, and every medium finding has an explicit
  mitigation and follow-up issue.

## 2. Re-verify the undocumented protocol

- [ ] The owner authorises a signed-in manual verification against live
  claude.ai traffic; repository tests alone cannot close this gate.
- [ ] Follow the owner-controlled live protocol verification checklist without
  recording credentials, conversation content, account email, or organisation
  identifiers.
- [ ] Confirm usage shapes, resets, statuses, account/billing invalidation, and
  refusal-boundary behavior still match the defensive parser. `status` must win
  over `utilization` at a limit boundary.
- [ ] Update the protocol verification date/evidence and obtain owner review.
  Any unexplained drift blocks launch rather than becoming a guessed value.

## 3. Stage the leaderboard stack

These checks do not authorise production access or a production change.

- [ ] Follow the complete
  [`docs/leaderboard-production.md`](docs/leaderboard-production.md) runbook.
  Obtain separate authorisation before even read-only production inspection.
- [ ] Run `supabase/preflight.sql` against the authorised source and accept only
  a documented supported shape; preserve metadata and aggregate counts, never
  account rows or credentials.
- [ ] Create a provider-supported backup, record its immutable identifier and
  retention, restore it into an isolated scratch/staging database, and prove the
  restored schema and aggregate counts. A started or untested backup is not a
  rollback asset.
- [ ] In staging, apply the reviewed migrations in filename order, rerunning
  preflight and count comparisons after each. Never use `schema.sql`,
  `reset.sql`, DROP, TRUNCATE, or a project reset to upgrade production.
- [ ] Probe effective PostgREST and database privileges: anon/authenticated have
  no Wick data or function access; service role has only the documented table
  operations plus execute access to the exact reviewed
  `forget_profile(text)` and `enroll_profile(text,text,text,text)` signatures;
  no alternate overload is exposed; RLS is enabled with no policies; the
  migration ledger is inaccessible to API roles.
- [ ] Prove Leave is atomic and account-wide in staging, including concurrent
  observation, cascades, idempotence, malformed-token handling, and removal of
  the profile, all browser tokens, and daily rows.
- [ ] Prove enrolment is atomic in staging: force token insertion to fail and
  confirm no new profile/email remains; confirm a folded-name conflict returns
  the reviewed retry result without a profile or token; and run concurrent first
  enrolments for one email, proving they converge on one assigned name while
  both successful browser token hashes remain bound.
- [ ] Present the evidence packet and exact migration filenames to the owner.
  Only an explicit, project-specific production migration approval permits the
  runbook's production steps; general release approval does not.

## 4. Verify the hosted Vercel edge

- [ ] With explicit staging authorisation, deploy the candidate using the
  intended environment-variable names and least-privilege service credential.
  Confirm secrets never enter source, artifacts, output, tickets, or request
  logs.
- [ ] Configure and test WAF/rate controls for enrol, submit, and Leave. Record
  bounded abuse probes showing the intended `429` behavior and recovery; static
  application tests do not establish hosted enforcement.
- [ ] Verify response caching at the deployed edge: mutations, private/error
  responses, and missing profiles are `no-store`; only intended public board
  responses receive the reviewed shared-cache policy. Confirm no private or
  token-bearing response is cached.
- [ ] Exercise enrol, one date-and-message-count submission, board/profile reads,
  account switching, and Leave with invented staging accounts. Inspect logs to
  confirm request bodies, emails, bearer tokens, and hashes are not emitted by
  application logging.
- [ ] Keep an enrolled test installation running across a completed local
  calendar-day rollover. Prove the extension sends the closed day only, the API
  accepts it, the store holds it, and the public board/profile render the same
  count while the new current day remains local.
- [ ] Warm the public board cache, then Leave with the invented account and
  observe the hosted edge until the participant disappears. Record timestamps
  proving no cached response serves the deleted participant beyond the
  documented 60-second freshness window.
- [ ] Record DNS/TLS, PostgREST schema-cache, timeout, error-rate, and availability
  observations. Hosted configuration and observation remain manual gates.

## 5. Smoke-test Chrome on Windows

- [ ] Load the unpacked `dist/` candidate in a clean Chrome profile on supported
  Windows and confirm there are no extension, content-script, or service-worker
  errors.
- [ ] Inspect the 16, 32, 48, and 128 pixel icons in the extension manager,
  toolbar, popup, and notification surfaces; confirm the live toolbar gauge and
  unknown state remain legible.
- [ ] Verify polling, percentage/status/reset display, daily rollup continuity,
  projection degradation to “unknown”, account/billing invalidation, and browser
  restart/update behavior.
- [ ] Trigger each notification threshold and reset path with controlled test
  state. Confirm deduplication and that notifications are local and require no
  network credential.
- [ ] Confirm install-time host/permission prompts match the manifest, the board
  origin is requested only from Join, denial/revocation leaves local tracking
  usable, and no unexpected permission appears.
- [ ] If a staging board is explicitly available, smoke-test Join, submission,
  account switching, retry/`429` handling, and Leave. Do not point an unpacked
  smoke candidate at production without separate authorisation.

## 6. Review privacy and store material

- [ ] Compare [`PRIVACY.md`](PRIVACY.md), README permissions, Chrome Web Store
  privacy/data-use answers, and the candidate behavior field by field. Disclose
  local account email storage, optional enrolment email transfer, daily
  date/message-count submissions, hosting logs, self-reported/unverified
  identity, optional host permission, and account-wide Leave accurately.
- [ ] Confirm the extension sends no analytics, telemetry, crash reporting,
  conversation content, percentages, window keys, hourly breakdown,
  organisation ID, or account email on daily submissions.
- [ ] Review name, short/long descriptions, category, support/security links,
  licence/source link, permissions justifications, and single-purpose statement.
- [ ] Capture current screenshots and promotional assets from the exact
  candidate. Check required dimensions, readable UI, no test data/PII, no
  misleading hosted claim, and no obsolete Telegram or token-counting claim.

## 7. Produce and verify deterministic artifacts

- [ ] Build/package twice from equivalent clean worktrees with the pinned Node
  and pnpm versions. Do not hand-edit either ZIP.
- [ ] Verify each ZIP with the repository package verifier. Confirm `dist/`
  contents are at archive root, entries are sorted with fixed metadata/time,
  manifest version/permissions/icon paths match, and source maps, credentials,
  and unrelated files are absent.
- [ ] Compare the two artifacts byte-for-byte and require identical SHA-256
  hashes. On Windows, record `Get-FileHash -Algorithm SHA256 <zip>` output;
  elsewhere use an equivalent SHA-256 tool.
- [ ] Record candidate commit, version, artifact filename, byte size, SHA-256,
  Node version, pnpm version, and verifier result in the release evidence. A
  rebuild after review creates a new candidate and must repeat these checks.

## 8. Prepare and review the GitHub draft

- [ ] Obtain separate owner authorisation to create the exact `vX.Y.Z` tag at
  the already reviewed candidate commit. Verify the candidate SHA again before
  tagging; do not move, replace, or force-update an existing tag.
- [ ] Record and obtain owner approval for the exact destination remote name and
  repository URL before any tag push; for the guarded workflow it must be the
  intended `https://github.com/RemasteredGod/Wick-` repository. Verify the
  configured remote resolves to that destination rather than assuming `origin`.
- [ ] Obtain separate owner authorisation to push that one tag to that approved
  remote, then verify the remote tag resolves to the recorded candidate SHA.
  Pushing a branch, passing CI, or approving this checklist does not authorise a
  tag or tag push. The draft workflow requires this exact existing remote tag
  and creates none.
- [ ] Run the guarded owner-triggered workflow, if present, only for the reviewed
  version/tag inputs and protected release environment. It may prepare a draft;
  it does not authorise publication or deployment.
- [ ] Verify the draft title/tag/version, target commit, changelog-derived notes,
  links, and attached ZIP/hash against the evidence packet. Do not attach source
  maps, secrets, database output, or user data.
- [ ] Obtain human review of the draft and final candidate diff. Keep it a draft
  until all protocol, hosted, Chrome, privacy, security, and store gates are
  closed and the owner explicitly approves publication.

## 9. Authorise and verify the production leaderboard

Completing staging does not authorise this section. Keep the leaderboard launch
blocked until every production observation below is recorded and reviewed.

- [ ] Identify the exact reviewed Vercel candidate commit/deployment, production
  project and domain, environment-variable names, and WAF, cache, and rate-limit
  configuration. Record configuration identifiers or hashes without recording
  secret values; a rebuild or configuration change creates a new candidate.
- [ ] Obtain separate, scope-specific owner approval to deploy or promote that
  exact candidate and configuration to production. Staging approval, database
  migration approval, general release approval, and this checklist are not
  production Vercel authorisation.
- [ ] Before promotion, document an owner-authorised, non-destructive disable or
  rollback path: restore the prior Vercel deployment or disable the affected API
  route/access path, preserve database data and the proved-restorable backup,
  and revoke a credential only if exposure requires it. Do not use a destructive
  schema rollback, down migration, reset, DROP, or TRUNCATE.
- [ ] Under that approval, deploy or promote without rebuilding or substituting
  configuration. Keep credentials least-privilege and do not enable or announce
  leaderboard launch merely because deployment completed.
- [ ] Before launch, observe production DNS/TLS and health, API availability and
  error rates, PostgREST schema-cache behavior, and timeouts. Run only bounded
  production probes with invented accounts and explicit owner approval; never
  use real user data.
- [ ] Re-verify production WAF/rate controls and recovery for enrol, submit, and
  Leave, including the expected `429` response. Re-verify cache headers so
  mutations, private/error responses, and missing profiles are `no-store`, no
  token-bearing response is cached, and only intended public responses receive
  the reviewed shared-cache policy.
- [ ] Stop and keep leaderboard launch blocked on a candidate/configuration
  mismatch, unexpected status or cache behavior, missing `429`, elevated errors,
  unhealthy dependencies, sensitive log output, or any unexplained observation.
- [ ] The owner reviews the production observation packet and separately decides
  whether leaderboard launch may proceed. Passing this gate does not authorise a
  GitHub publication, Web Store upload, publication, or rollout.

## 10. Chrome Web Store submission

- [ ] After explicit upload approval, upload exactly the hash-verified ZIP to the
  intended listing; do not rebuild in the dashboard path.
- [ ] Recheck the dashboard's parsed version, permissions, package warnings,
  privacy practices, regions, visibility, and rollout settings before submit.
- [ ] Save submission/review identifiers and reviewer questions without secrets
  or user data. Treat rejection or a requested code change as a new candidate
  requiring relevant validation and a new artifact hash.
- [ ] Publication and rollout require a final owner decision after Web Store
  review. A GitHub draft or approved store review is not that decision.

## 11. Observe, stop, and recover

- [ ] Before rollout, name the operator, observation window, stop contact, and
  rollback/mitigation actions for extension, Vercel, and Supabase separately.
- [ ] Monitor Web Store status/adoption, extension errors and support reports,
  API availability/error/`429` rates, cache behavior, Supabase/PostgREST errors,
  submissions, and Leave completion. Use aggregate/platform observations only;
  add no analytics or new logging.
- [ ] On an extension regression, halt/stage the rollout where available and
  prepare a fixed package with a new higher version; a published version cannot
  be replaced in place.
- [ ] On a leaderboard regression, disable or roll back the affected API
  deployment/access path under owner authorisation. Preserve data and the proven
  backup; do not improvise a destructive database rollback or down migration.
- [ ] Revoke exposed credentials immediately through the provider, assess via
  the private security process in [`SECURITY.md`](SECURITY.md), and do not put
  exploit details in a public issue before a fix is available.
- [ ] Keep release evidence and the restorable backup for the agreed period.
  Close the release only after the owner reviews observations and outstanding
  follow-up work.

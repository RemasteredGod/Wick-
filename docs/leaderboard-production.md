# Leaderboard production database runbook

This runbook is a procedure for a future, explicitly authorised deployment. It is **not authorisation to inspect or change Supabase/Vercel now**. The repository tests are static evidence only; they do not prove the state of a hosted database.

## Cardinal rule

Never run `supabase/reset.sql`, `DROP`, `TRUNCATE`, a Supabase project reset, or a destructive “repair” against production. Do not paste `schema.sql` over an existing database. Production changes are the ordered, reviewed files under `supabase/migrations/`, after every gate below passes.

Stop on any unexpected shape, count, constraint, policy, grant, migration version, warning, or error. Preserve the output and backup; do not improvise.

## Artifacts and supported starting points

- `supabase/schema.sql`: idempotent final snapshot for a fresh database, not an existing-database upgrade.
- `supabase/preflight.sql`: read-only metadata/count report and safety gate.
- `supabase/migrations/0001_token_key_to_email_key.sql`: accepts the known current email-key shape, or converts the known legacy token-key shape only when it is empty.
- `supabase/migrations/0002_atomic_forget_profile.sql`: verifies cascades, installs atomic Leave, and applies its interim ACL/RLS posture.
- `supabase/migrations/0003_atomic_enroll.sql`: installs transactional profile/token enrolment and removes direct profile/token mutation grants.
- `supabase/reset.sql`: guarded disposable-local-development helper only.

The legacy shape has no account email. If it contains profiles or rows, no automatic truthful mapping exists. The preflight and migration intentionally abort. That case requires a separate owner-approved identity/re-enrolment decision; deleting or relabelling rows is not a migration.

## Required evidence packet

Keep one dated change record containing:

1. reviewed commit and SHA-256 hashes of preflight/migration files;
2. read-only production preflight output;
3. backup identifier, completion time, retention, and successful scratch-restore evidence;
4. staging source/shape, migration transcript, before/after aggregate counts, functional probes, and privilege probes;
5. named operator and rollback/stop contact;
6. the repository test/typecheck/build results for the same commit;
7. the owner’s exact production confirmation.

Outputs must contain aggregate counts and metadata only. Do not copy emails, names, token hashes, row values, service keys, or bearer tokens into tickets or logs.

## Gate 1 — authorise and inspect

Obtain owner authorisation for **read-only production inspection**. Then run `supabase/preflight.sql` as the database owner and save its complete result/NOTICE stream.

Accept only one of these reports:

- `shape=current-email-key` with zero orphan tokens, zero orphan rows, zero invalid hashes, both email foreign keys using `ON DELETE CASCADE`, and no unexpected RLS policy; or
- `shape=legacy-token-key` with exactly zero profiles and zero daily rows.

Anything else is a hard stop. Compare table counts with the board’s expected operational state. Record current RLS flags, policies, effective grants, function ACL, and migration ledger. Inspection does not authorise migration.

## Gate 2 — create and prove a restorable backup

Use the hosting provider’s supported full database backup/export for the production project. Record its immutable identifier, timestamp, encryption/access controls, retention, and included schemas. A “backup started” message is not evidence.

Restore that backup into a separate, access-restricted scratch/staging database. Run the preflight there and compare schema plus aggregate counts with the source preflight. Exercise a read of every Wick table. Keep the restore transcript. If a scratch restore cannot be completed, the backup is not proven restorable and production migration is blocked.

Never test restoration by overwriting production.

## Gate 3 — rehearse in staging

Use the restored production copy when available. Also exercise these fixtures in isolated staging databases:

1. fresh database: apply `schema.sql` twice and confirm the second run is a no-op;
2. exact empty legacy token-key shape: preflight, then `0001`, then `0002`, then `0003`;
3. exact populated current email-key shape: preflight, then `0001`, then `0002`, then `0003`, preserving all aggregate counts;
4. populated legacy shape: confirm preflight/`0001` abort without changing rows;
5. same-column partial shapes: independently change a type, nullability/default, profile name uniqueness, daily composite primary key, message nonnegative check, either cascade, or either required index; confirm preflight and the applicable migration abort before any committed mutation;
6. incorrect token constraint: install a weaker check named `tokens_token_hash_format`; confirm preflight, `schema.sql`, and `0002` reject its definition rather than accepting or validating it;
7. migration-ledger shape fixtures: independently add/remove a ledger column, change `applied_at` nullability/default/type, or remove/change the `version` primary key; confirm preflight and each applicable schema/migration path abort before a committed base-table mutation;
8. migration-ledger content fixtures: test an unknown version, a known version with a conflicting description, `0002` without `0001`, `0003` without either prefix, and a legacy base shape claiming `0001`; confirm all are rejected, while empty, exact `0001`, exact ordered `0001`+`0002`, and exact ordered `0001`+`0002`+`0003` states are accepted only at their applicable stage;
9. any other unknown/partially migrated shape: confirm preflight aborts.

Apply migrations in filename order, one file at a time, and save each transcript. After each file, rerun preflight and compare aggregate counts. Do not continue after a rolled-back transaction or unexpected notice.

### Staging functional probe

Use invented `.invalid` fixture data only. In a transaction, insert one profile, two token hashes, and one daily row. Call `forget_profile` with one hash. It must return `true`; the profile, both tokens, and row must all be absent. A second call and malformed/null hashes must return `false` without changing other fixtures. Roll back the probe transaction.

Repeat with concurrent staging sessions: while one session invokes `forget_profile`, no observer may see a committed state containing only part of that account. This hosted observation, plus verified cascades, closes the atomicity check; static SQL tests alone do not.

Probe `enroll_profile` separately with invented `.invalid` accounts and 64-character lowercase hexadecimal hashes. Confirm a first call creates exactly one profile and one token and returns its assigned name with `existing=false`; a second browser for the same email keeps that exact name, inserts a different hash, and returns `existing=true`. Force a token insert failure inside a transaction and confirm no new profile/email remains. Give two different emails the same folded candidate and confirm the loser receives the distinguishable `PT409`/HTTP `409` path with neither a profile nor token retained; retry it with a free candidate.

Repeat first enrolment concurrently from two staging sessions for one email, using different candidate names and token hashes. Both calls must commit against one profile, both results must carry the winner's exact name, and both token rows must point to that email. Observe transaction/concurrency and rollback behavior in PostgreSQL and through PostgREST; repository static tests deliberately do not claim to close these hosted checks. Roll back or delete all invented fixtures before retaining aggregate-only evidence.

### Staging privilege probes

Check effective privileges as each API role, not merely the text of GRANT statements.

- `anon` and `authenticated`: no USAGE/CREATE on the `public` schema, no SELECT/INSERT/UPDATE/DELETE on `profiles`, `tokens`, `daily_rows`, or `wick_schema_migrations`, and no EXECUTE on `forget_profile` or `enroll_profile`.
- `service_role`: USAGE but not CREATE on the `public` schema; SELECT only on `profiles` and `tokens`; SELECT+INSERT+UPDATE on `daily_rows`; no direct INSERT/UPDATE/DELETE on `profiles` or `tokens`; no direct DELETE on any data table; EXECUTE on exactly the reviewed `forget_profile(text)` and `enroll_profile(text,text,text,text)` signatures.
- all Wick tables: RLS enabled and zero policies.
- migration ledger: no table privilege for any of the three API roles, including `service_role`.

Probe expected denials through PostgREST in staging as well as with the complete `has_*_privilege` matrix. Confirm anon/authenticated profile, token, daily-row, ledger, and both RPC requests are denied; confirm service-role direct profile/token inserts and every ledger operation are denied. A service-role malformed-hash Leave RPC must safely return false, while malformed enrollment input must fail without a row. Normal adapter reads, the enrollment RPC, and daily upserts must still work. Confirm PostgREST exposes no overloaded/alternate signature for either RPC. Never print keys, emails, names, or hashes in commands or captured evidence.

## Gate 4 — explicit owner confirmation

Present the evidence packet and exact proposed migration filenames. Production remains blocked until the owner provides an explicit confirmation equivalent to:

> I reviewed the production preflight, proved backup restore, staging migration and privilege/atomicity probes for this commit, and authorise applying migrations 0001, 0002, and 0003 to the identified production Supabase project. I understand reset/drop operations are not authorised.

A general “ship it”, prior approval, issue assignment, or staging approval is insufficient. Record the project identifier and confirmation time without recording credentials.

## Gate 5 — production migration

During the approved change window:

1. verify project identity and file hashes again;
2. ensure the restorable backup remains available;
3. run preflight again and compare it with Gate 1;
4. apply `0001_token_key_to_email_key.sql`; stop on any error;
5. run preflight and compare counts;
6. apply `0002_atomic_forget_profile.sql`; stop on any error;
7. run preflight and compare counts;
8. apply `0003_atomic_enroll.sql`; stop on any error;
9. run preflight and the non-mutating privilege checks, including the ledger matrix and both RPC signatures;
10. make owner-approved canaries through the real enrolment and Leave paths only with disposable test profiles.

Each migration is transactional; an error must roll that file back. There is no destructive down migration. If post-checks fail, disable the affected API deployment/access path and investigate from the backup rather than dropping tables or hand-editing participant data.

## Gate 6 — observe and close

Verify API health, PostgREST errors, Leave idempotence, profile disappearance, and that board reads/submissions still operate. Confirm no raw account data entered logs. Keep the backup through the agreed observation period.

Static repository tests can prove adapter request shape and reviewed SQL text. They **cannot** close hosted schema shape, data counts, backup restorability, migration execution, transaction/concurrency behaviour, effective privileges, PostgREST schema cache, WAF, edge cache, or deployment observations. Those remain staging/production gates with separate evidence.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1');
const text = (path: string) => readFileSync(join(root, path), 'utf8');
const withoutLineComments = (sql: string) => sql.replace(/--.*$/gm, '');

const schema = text('supabase/schema.sql');
const preflight = text('supabase/preflight.sql');
const reset = text('supabase/reset.sql');
const runbook = text('docs/leaderboard-production.md');
const migrationDir = join(root, 'supabase/migrations');
const migrationNames = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
const migration = (name: string) => text(`supabase/migrations/${name}`);

describe('fresh Supabase schema', () => {
  it('is an idempotent final snapshot that records the ordered versions', () => {
    expect(schema).toContain('create table if not exists public.profiles');
    expect(schema).toContain('create table if not exists public.tokens');
    expect(schema).toContain('create table if not exists public.daily_rows');
    expect(schema).toContain('create or replace function public.forget_profile');
    expect(schema).toContain('create or replace function public.enroll_profile');
    expect(schema).toContain("('0001', 'token-key to email-key account schema')");
    expect(schema).toContain("('0002', 'atomic forget_profile and explicit privileges')");
    expect(schema).toContain("('0003', 'atomic enroll_profile and least-privilege writes')");
    expect(schema).toContain("pg_advisory_xact_lock(hashtext('wick-schema-migration'))");
    expect(schema).toContain('where not exists (');
    expect(schema).not.toContain('on conflict (version) do nothing');
    expect(schema).toContain('Wick schema shape is not the reviewed current shape');
  });

  it('makes one profile delete and relies on both verified cascades', () => {
    const sql = withoutLineComments(schema).toLowerCase();
    expect(sql.match(/references public\.profiles \(email\) on delete cascade/g)).toHaveLength(2);
    expect(sql).toContain('delete from public.profiles as profile');
    expect(sql).toContain('using public.tokens as token');
    expect(sql).not.toContain('delete from public.tokens');
    expect(sql).not.toContain('delete from public.daily_rows');
    expect(sql).toContain(
      'foreign key (email) references profiles(email) on delete cascade|primary key (token_hash)',
    );
    expect(sql).toContain(
      'foreign key (email) references profiles(email) on delete cascade|primary key (email, day)',
    );
  });

  it('returns false for malformed/missing hashes without retaining a tombstone', () => {
    expect(schema).toContain("p_token_hash !~ '^[0-9a-f]{64}$'");
    expect(schema).toContain('return false;');
    expect(schema).toContain('return deleted_count = 1;');
    expect(schema.toLowerCase()).not.toMatch(/soft_delete|deleted_at|tombstone/);
  });

  it('has explicit no-policy RLS and least-required API grants', () => {
    for (const table of ['profiles', 'tokens', 'daily_rows', 'wick_schema_migrations']) {
      expect(schema).toContain(`alter table public.${table} enable row level security`);
      expect(schema).toContain(
        `revoke all privileges on table public.${table} from public, anon, authenticated, service_role`,
      );
    }
    expect(schema).toContain(
      'revoke all privileges on schema public from public, anon, authenticated, service_role',
    );
    expect(schema).toContain('grant usage on schema public to service_role');
    expect(schema).toContain('grant select on table public.profiles to service_role');
    expect(schema).toContain('grant select on table public.tokens to service_role');
    expect(schema).not.toMatch(/grant[^;]*insert[^;]*table public\.profiles[^;]*service_role/i);
    expect(schema).not.toMatch(/grant[^;]*insert[^;]*table public\.tokens[^;]*service_role/i);
    expect(schema).toContain(
      'grant select, insert, update on table public.daily_rows to service_role',
    );
    expect(schema).not.toMatch(/grant[^;]*delete[^;]*service_role/i);
    expect(schema).toContain(
      'revoke all privileges on function public.forget_profile(text) from public, anon, authenticated, service_role',
    );
    expect(schema).toContain(
      'grant execute on function public.forget_profile(text) to service_role',
    );
    expect(schema).toContain(
      'revoke all privileges on function public.enroll_profile(text, text, text, text) from public, anon, authenticated, service_role',
    );
    expect(schema).toContain(
      'grant execute on function public.enroll_profile(text, text, text, text) to service_role',
    );
    expect(schema).toContain('select 1 from pg_policy');
  });

  it('fails closed unless both public RPCs have exactly the reviewed signatures', () => {
    expect(schema).toContain("routine.proname = 'forget_profile'");
    expect(schema).toContain(
      "pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text'",
    );
    expect(schema).toContain('not routine.proretset');
    expect(schema).toContain("pg_get_function_result(routine.oid) = 'boolean'");
    expect(schema).toContain(
      'Enrollment RPCs do not have the reviewed SECURITY DEFINER shapes',
    );
  });
});

describe('ordered Supabase migrations', () => {
  it('has exactly the reviewed order', () => {
    expect(migrationNames).toEqual([
      '0001_token_key_to_email_key.sql',
      '0002_atomic_forget_profile.sql',
      '0003_atomic_enroll.sql',
    ]);
  });

  it('uses transactions, a shared lock, and no destructive table operation', () => {
    for (const name of migrationNames) {
      const sql = withoutLineComments(migration(name)).toLowerCase();
      expect(sql.trimStart()).toMatch(/^begin;/);
      expect(sql).toContain("pg_advisory_xact_lock(hashtext('wick-schema-migration'))");
      expect(sql.trimEnd()).toMatch(/commit;$/);
      expect(sql).not.toMatch(/\b(drop|truncate)\s+(table\s+)?/);
      expect(sql).not.toMatch(/\bdelete\s+from\s+public\.(tokens|daily_rows)\b/);
    }
  });

  it('converts only the complete empty legacy shape and accepts complete current shapes', () => {
    const first = migration('0001_token_key_to_email_key.sql');
    expect(first).toContain(
      'token_hash:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE',
    );
    expect(first).toContain('token_hash:text:t:,day:date:t:,messages:integer:t:');
    expect(first).toContain('PRIMARY KEY (token_hash)|UNIQUE (name_folded)');
    expect(first).toContain(
      'CHECK ((messages >= 0))|FOREIGN KEY (token_hash) REFERENCES profiles(token_hash) ON DELETE CASCADE|PRIMARY KEY (token_hash, day)',
    );
    expect(first).toContain(
      'email:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE',
    );
    expect(first).toContain('email:text:t:,day:date:t:,messages:integer:t:');
    expect(first).toContain('PRIMARY KEY (email)|UNIQUE (name_folded)');
    expect(first).toContain('constraints_validated and has_day_index');
    expect(first).toContain('has_token_email_index');
    expect(first).toContain('reviewed_rls');
    expect(first).toContain('if profile_count <> 0 or row_count <> 0 then');
    expect(first).toContain('Populated token-key schema cannot be migrated automatically');
    expect(first).toContain('alter table public.profiles rename column token_hash to email');
    expect(first).toContain('alter table public.daily_rows rename column token_hash to email');
    expect(first).toContain('Unknown Wick schema shape; migration refused');
  });

  it('verifies the complete current shape before installing the single-delete RPC', () => {
    const second = withoutLineComments(migration('0002_atomic_forget_profile.sql')).toLowerCase();
    expect(second).toContain('requires exact ordered ledger entry 0001');
    expect(second).toContain('format_type(a.atttypid, a.atttypmod)');
    expect(second).toContain('pg_get_expr(d.adbin, d.adrelid)');
    expect(second).toContain("'primary key (email)|unique (name_folded)'");
    expect(second).toContain(
      "'check ((messages >= 0))|foreign key (email) references profiles(email) on delete cascade|primary key (email, day)'",
    );
    expect(second).toContain('not convalidated');
    expect(second).toContain("idx.relname = 'daily_rows_day_idx'");
    expect(second).toContain("idx.relname = 'tokens_email_idx'");
    expect(second).toContain('i.indisvalid and i.indisready');
    expect(second).toContain('invalid_hashes');
    expect(second).toContain('create or replace function public.forget_profile');
    expect(second).toContain('delete from public.profiles as profile');
    expect(second).not.toContain('delete from public.tokens');
    expect(second).not.toContain('delete from public.daily_rows');
    expect(second).toContain('revoke all privileges on function public.forget_profile(text)');
  });

  it('installs one locked atomic enrollment RPC with rollback-safe failure paths', () => {
    const third = migration('0003_atomic_enroll.sql');
    const sql = withoutLineComments(third).toLowerCase();

    expect(third).toContain('requires exact ordered ledger entries 0001 and 0002');
    expect(third).toContain('create or replace function public.enroll_profile');
    expect(sql).toContain('returns table(name text, existing boolean)');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog, public');
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(p_email, 0))');
    expect(sql.indexOf('insert into public.profiles')).toBeLessThan(
      sql.indexOf('insert into public.tokens'),
    );
    expect(sql).toContain("p_token_hash !~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("raise sqlstate 'pt409'");
    expect(sql).toContain("conflicting.name_folded = p_name_folded");
    expect(sql).toContain('conflicting.email <> p_email');
    expect(sql).toContain('return query select result_name, was_existing');
    expect(sql).not.toContain('exception when others');
    expect(third).toContain(
      'revoke all privileges on function public.enroll_profile(text, text, text, text) from public, anon, authenticated, service_role',
    );
    expect(third).toContain(
      'grant execute on function public.enroll_profile(text, text, text, text) to service_role',
    );
    expect(third).toContain('grant select on table public.profiles to service_role');
    expect(third).toContain('grant select on table public.tokens to service_role');
    expect(third).not.toMatch(/grant[^;]*insert[^;]*table public\.(profiles|tokens)[^;]*service_role/i);
    expect(third).toContain('Migration 0003 found an unreviewed forget_profile overload');
    expect(third).toContain(
      "pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text'",
    );
    expect(sql).toContain('not routine.proretset');
    expect(sql).toContain("pg_get_function_result(routine.oid) = 'boolean'");
    expect(third).toContain(
      'Enrollment RPCs do not have the reviewed SECURITY DEFINER shapes',
    );
  });

  it('rejects same-column partial schemas and a same-named weaker hash check', () => {
    const guarded = [
      schema,
      preflight,
      migration('0001_token_key_to_email_key.sql'),
      migration('0002_atomic_forget_profile.sql'),
      migration('0003_atomic_enroll.sql'),
    ];

    for (const sql of guarded) {
      expect(sql).toContain("format('%s:%s:%s:%s'");
      expect(sql).toContain('format_type(a.atttypid, a.atttypmod)');
      expect(sql).toContain('pg_get_expr(d.adbin, d.adrelid)');
      expect(sql).toContain('PRIMARY KEY (email)|UNIQUE (name_folded)');
      expect(sql).toContain(
        'CHECK ((messages >= 0))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (email, day)',
      );
      expect(sql).toContain("idx.relname = 'daily_rows_day_idx'");
      expect(sql).toContain("idx.relname = 'tokens_email_idx'");
      expect(sql).toContain("pg_get_indexdef(i.indexrelid, 1, true) = 'day'");
      expect(sql).toContain("pg_get_indexdef(i.indexrelid, 1, true) = 'email'");
      expect(sql).toContain("conname = 'tokens_token_hash_format'");
      expect(sql).toContain(
        "'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))'",
      );
    }

    const second = migration('0002_atomic_forget_profile.sql');
    expect(second).toContain('existing_definition <>');
    expect(second).toContain(
      'Existing tokens_token_hash_format constraint has an unreviewed definition',
    );
    expect(second.indexOf('existing_definition <>')).toBeLessThan(
      second.indexOf('alter table public.tokens validate constraint tokens_token_hash_format'),
    );
  });

  it('rejects partial ledgers, conflicting descriptions, and unknown versions', () => {
    const guarded = [
      schema,
      preflight,
      migration('0001_token_key_to_email_key.sql'),
      migration('0002_atomic_forget_profile.sql'),
      migration('0003_atomic_enroll.sql'),
    ];

    for (const sql of guarded) {
      expect(sql).toContain(
        'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()',
      );
      expect(sql).toContain("ledger_constraints is distinct from 'PRIMARY KEY (version)'");
      expect(sql).toContain('ledger_versions');
      expect(sql).toContain('ledger_content_valid');
      expect(sql).toContain("version = '0001'");
      expect(sql).toContain("description = 'token-key to email-key account schema'");
      expect(sql).toContain("version = '0002'");
      expect(sql).toContain("description = 'atomic forget_profile and explicit privileges'");
      expect(sql).toContain("version = '0003'");
      expect(sql).toContain(
        "description = 'atomic enroll_profile and least-privilege writes'",
      );
      expect(sql.toLowerCase()).toMatch(/unknown[^;]*(ledger|migration)|ledger[^;]*unknown/);
    }

    const first = migration('0001_token_key_to_email_key.sql');
    expect(first).toContain('Legacy Wick schema has impossible migration ledger history');
    expect(first.indexOf('requires the exact reviewed migration ledger shape')).toBeLessThan(
      first.indexOf('alter table public.profiles rename column token_hash to email'),
    );
    expect(first.indexOf('found unknown, out-of-order, or conflicting ledger entries')).toBeLessThan(
      first.indexOf('alter table public.profiles rename column token_hash to email'),
    );

    const second = migration('0002_atomic_forget_profile.sql');
    expect(second).toContain('requires exact ordered ledger entry 0001');
    expect(second.indexOf('requires the exact reviewed migration ledger shape')).toBeLessThan(
      second.indexOf('create or replace function public.forget_profile'),
    );
    expect(second.indexOf('requires exact ordered ledger entry 0001')).toBeLessThan(
      second.indexOf('create or replace function public.forget_profile'),
    );
    expect(second).not.toContain('on conflict (version) do nothing');

    expect(preflight).toContain(
      'PREFLIGHT BLOCKED: unknown migration ledger shape or RLS posture',
    );
    expect(preflight).toContain(
      'PREFLIGHT BLOCKED: unknown, out-of-order, or conflicting migration ledger entries',
    );
    expect(preflight).toContain(
      'PREFLIGHT BLOCKED: legacy shape has impossible migration ledger history',
    );
  });
});

describe('upgrade safety material', () => {
  it('preflight reports shape/counts/security and blocks unsafe assumptions', () => {
    expect(preflight).toContain('Shape report');
    expect(preflight).toContain('Exact aggregate counts and safety gate');
    expect(preflight).toContain('orphan_tokens');
    expect(preflight).toContain('invalid_hashes');
    expect(preflight).toContain('has_schema_privilege');
    expect(preflight).toContain('has_table_privilege');
    expect(preflight).toContain("'wick_schema_migrations'");
    expect(preflight).toContain("routine.proname in ('enroll_profile', 'forget_profile')");
    expect(preflight).toContain('has_function_privilege');
    expect(preflight).toContain("routine.proname = 'forget_profile'");
    expect(preflight).toContain(
      "pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text'",
    );
    expect(preflight).toContain(
      'PREFLIGHT BLOCKED: unreviewed enrollment RPC shape or overload',
    );
    expect(preflight).toContain('PREFLIGHT BLOCKED: unknown Wick schema shape');
    expect(preflight).toContain('PREFLIGHT BLOCKED: populated legacy token-key schema');

    const sql = withoutLineComments(preflight).toLowerCase();
    expect(sql).not.toMatch(/^\s*(insert|update|delete|alter|create|drop|truncate)\s+/m);
  });

  it('makes local reset fail closed before the first destructive statement', () => {
    const guard = reset.indexOf("current_setting('wick.allow_destructive_reset', true)");
    const firstDrop = reset.toLowerCase().indexOf('drop table');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(firstDrop).toBeGreaterThan(guard);
    expect(reset).toContain('destructive reset disabled');
    expect(reset).toContain('disposable local database');
  });

  it('keeps hosted verification as explicit owner-gated staging work', () => {
    expect(runbook).toContain('read-only production preflight output');
    expect(runbook).toContain('successful scratch-restore evidence');
    expect(runbook).toContain('Gate 3 — rehearse in staging');
    expect(runbook).toContain('same-column partial shapes');
    expect(runbook).toContain('incorrect token constraint');
    expect(runbook).toContain('migration-ledger shape fixtures');
    expect(runbook).toContain('migration-ledger content fixtures');
    expect(runbook).toContain('unknown version');
    expect(runbook).toContain('conflicting description');
    expect(runbook).toContain('confirm preflight and the applicable migration abort');
    expect(runbook).toContain('Staging privilege probes');
    expect(runbook).toContain('Force a token insert failure');
    expect(runbook).toContain('Repeat first enrolment concurrently');
    expect(runbook).toContain('PT409`/HTTP `409');
    expect(runbook).toContain('service-role direct profile/token inserts');
    expect(runbook).toContain('migration ledger');
    expect(runbook).toContain('Gate 4 — explicit owner confirmation');
    expect(runbook).toContain('Never run `supabase/reset.sql`, `DROP`, `TRUNCATE`');
    expect(runbook).toContain('Static repository tests');
    expect(runbook).toContain('cannot');
  });
});

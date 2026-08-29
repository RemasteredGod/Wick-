-- 0001: move from the legacy token-key shape to the email-key account shape.
--
-- Run supabase/preflight.sql first. The legacy schema has no email anywhere, so
-- populated legacy rows cannot be mapped to accounts without inventing data.
-- This migration therefore converts only an empty legacy shape and aborts on a
-- populated or unknown shape. The known current email-key shape is validated
-- and recorded without rewriting it.
--
-- Transactional and idempotent. No table is dropped and no row is deleted.

begin;
select pg_advisory_xact_lock(hashtext('wick-schema-migration'));

create table if not exists public.wick_schema_migrations (
  version      text primary key,
  description  text not null,
  applied_at   timestamptz not null default statement_timestamp()
);

do $migration$
declare
  profile_signature text;
  token_signature text;
  row_signature text;
  ledger_signature text;
  profile_constraints text;
  token_constraints text;
  row_constraints text;
  ledger_constraints text;
  ledger_versions text;
  ledger_content_valid boolean;
  profile_count bigint;
  row_count bigint;
  has_day_index boolean;
  has_token_email_index boolean;
  has_reviewed_hash_check boolean;
  constraints_validated boolean;
  ledger_constraints_validated boolean;
  reviewed_rls boolean;
  is_legacy boolean;
  is_current boolean;
begin
  -- A matching column list is not a known shape. Include every committed
  -- column type, nullability flag, and default before examining constraints.
  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into profile_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = to_regclass('public.profiles')
     and a.attnum > 0 and not a.attisdropped;
  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into token_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = to_regclass('public.tokens')
     and a.attnum > 0 and not a.attisdropped;
  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into row_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = to_regclass('public.daily_rows')
     and a.attnum > 0 and not a.attisdropped;

  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into ledger_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.wick_schema_migrations'::regclass
     and a.attnum > 0 and not a.attisdropped;

  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into profile_constraints
    from pg_constraint
   where conrelid = to_regclass('public.profiles');
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into token_constraints
    from pg_constraint
   where conrelid = to_regclass('public.tokens');
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into row_constraints
    from pg_constraint
   where conrelid = to_regclass('public.daily_rows');
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into ledger_constraints
    from pg_constraint
   where conrelid = 'public.wick_schema_migrations'::regclass;
  select not exists (
    select 1 from pg_constraint
     where conrelid = 'public.wick_schema_migrations'::regclass
       and not convalidated
  ) into ledger_constraints_validated;
  select not exists (
    select 1 from pg_constraint
     where conrelid in (to_regclass('public.profiles'),
                        to_regclass('public.tokens'),
                        to_regclass('public.daily_rows'))
       and not convalidated
  ) into constraints_validated;
  select count(*) = 0
    into reviewed_rls
    from pg_class cls
    join pg_namespace ns on ns.oid = cls.relnamespace
    left join pg_policy pol on pol.polrelid = cls.oid
   where ns.nspname = 'public'
     and cls.relname in ('profiles', 'tokens', 'daily_rows')
     and (not cls.relrowsecurity or pol.oid is not null);

  select exists (
    select 1
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_am am on am.oid = idx.relam
     where i.indrelid = to_regclass('public.daily_rows')
       and idx.relnamespace = 'public'::regnamespace
       and idx.relname = 'daily_rows_day_idx'
       and am.amname = 'btree'
       and i.indisvalid and i.indisready and not i.indisunique
       and i.indnkeyatts = 1 and i.indnatts = 1
       and i.indpred is null and i.indexprs is null
       and pg_get_indexdef(i.indexrelid, 1, true) = 'day'
  ) into has_day_index;
  select exists (
    select 1
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_am am on am.oid = idx.relam
     where i.indrelid = to_regclass('public.tokens')
       and idx.relnamespace = 'public'::regnamespace
       and idx.relname = 'tokens_email_idx'
       and am.amname = 'btree'
       and i.indisvalid and i.indisready and not i.indisunique
       and i.indnkeyatts = 1 and i.indnatts = 1
       and i.indpred is null and i.indexprs is null
       and pg_get_indexdef(i.indexrelid, 1, true) = 'email'
  ) into has_token_email_index;
  select exists (
    select 1
      from pg_constraint
     where conrelid = to_regclass('public.tokens')
       and conname = 'tokens_token_hash_format'
       and contype = 'c' and convalidated
       and pg_get_constraintdef(oid) =
           'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))'
  ) into has_reviewed_hash_check;

  if ledger_signature is distinct from
       'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()'
     or ledger_constraints is distinct from 'PRIMARY KEY (version)'
     or not ledger_constraints_validated then
    raise exception using
      message = 'Migration 0001 requires the exact reviewed migration ledger shape',
      detail = format('ledger=(%s; %s), constraints_validated=%s',
                      ledger_signature, ledger_constraints,
                      ledger_constraints_validated),
      hint = 'Extra or missing columns/defaults/constraints are not migration history. Stop and inspect provenance.';
  end if;

  select string_agg(format('%s:%s', version, description), '|' order by version),
         not exists (
           select 1 from public.wick_schema_migrations
            where not (
              (version = '0001' and description = 'token-key to email-key account schema')
              or (version = '0002' and description = 'atomic forget_profile and explicit privileges')
              or (version = '0003' and description = 'atomic enroll_profile and least-privilege writes')
            )
         ) and not (
           exists (select 1 from public.wick_schema_migrations where version = '0002')
           and not exists (select 1 from public.wick_schema_migrations where version = '0001')
         ) and not (
           exists (select 1 from public.wick_schema_migrations where version = '0003')
           and (
             not exists (select 1 from public.wick_schema_migrations where version = '0001')
             or not exists (select 1 from public.wick_schema_migrations where version = '0002')
           )
         )
    into ledger_versions, ledger_content_valid
    from public.wick_schema_migrations;
  if not ledger_content_valid then
    raise exception using
      message = 'Migration 0001 found unknown, out-of-order, or conflicting ledger entries',
      detail = coalesce(ledger_versions, '<empty>'),
      hint = 'Do not overwrite migration history. Preserve the preflight output and inspect provenance.';
  end if;

  is_legacy := profile_signature =
      'token_hash:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE'
    and token_signature is null
    and row_signature = 'token_hash:text:t:,day:date:t:,messages:integer:t:'
    and profile_constraints =
      'PRIMARY KEY (token_hash)|UNIQUE (name_folded)'
    and row_constraints =
      'CHECK ((messages >= 0))|FOREIGN KEY (token_hash) REFERENCES profiles(token_hash) ON DELETE CASCADE|PRIMARY KEY (token_hash, day)'
    and constraints_validated and has_day_index and reviewed_rls;
  is_current := profile_signature =
      'email:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE'
    and token_signature =
      'token_hash:text:t:,email:text:t:,created_on:date:t:CURRENT_DATE'
    and row_signature = 'email:text:t:,day:date:t:,messages:integer:t:'
    and profile_constraints = 'PRIMARY KEY (email)|UNIQUE (name_folded)'
    and row_constraints =
      'CHECK ((messages >= 0))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (email, day)'
    and (
      token_constraints =
        'FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
      or (token_constraints =
        'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
        and has_reviewed_hash_check)
    )
    and constraints_validated and has_day_index and has_token_email_index
    and reviewed_rls;

  if is_legacy then
    if ledger_versions is not null then
      raise exception using
        message = 'Legacy Wick schema has impossible migration ledger history',
        detail = ledger_versions,
        hint = 'Migration 0001 cannot be recorded before its legacy-to-current rename commits. Stop and inspect provenance.';
    end if;

    execute 'select count(*) from public.profiles' into profile_count;
    execute 'select count(*) from public.daily_rows' into row_count;

    if profile_count <> 0 or row_count <> 0 then
      raise exception using
        message = 'Populated token-key schema cannot be migrated automatically',
        detail = format('profiles=%s, daily_rows=%s; the legacy schema contains no account email',
                        profile_count, row_count),
        hint = 'Stop without resetting. Preserve the backup and obtain an owner-approved identity/re-enrolment decision.';
    end if;

    -- Renaming empty key columns preserves the already-verified constraints and
    -- index. PostgreSQL follows the referenced-column rename in the foreign key.
    alter table public.profiles rename column token_hash to email;
    alter table public.daily_rows rename column token_hash to email;

    create table public.tokens (
      token_hash  text primary key,
      email       text not null references public.profiles (email) on delete cascade,
      created_on  date not null default current_date
    );
    create index tokens_email_idx on public.tokens (email);
  elsif not is_current then
    raise exception using
      message = 'Unknown Wick schema shape; migration refused',
      detail = format('profiles=(%s; %s), tokens=(%s; %s), daily_rows=(%s; %s), indexes=(day:%s, token_email:%s)',
                      profile_signature, profile_constraints,
                      token_signature, token_constraints,
                      row_signature, row_constraints,
                      has_day_index, has_token_email_index),
      hint = 'Do not reset or edit the migration. Capture preflight output and review the actual schema.';
  end if;

  insert into public.wick_schema_migrations (version, description)
  select '0001', 'token-key to email-key account schema'
   where not exists (
     select 1 from public.wick_schema_migrations where version = '0001'
   );
end
$migration$;

alter table public.wick_schema_migrations enable row level security;
revoke all privileges on table public.wick_schema_migrations
  from public, anon, authenticated, service_role;

-- Keep the database closed to client roles even if 0002 is applied in a
-- separate transaction or session immediately afterwards.
alter table public.profiles enable row level security;
alter table public.tokens enable row level security;
alter table public.daily_rows enable row level security;
revoke all privileges on table public.profiles from public, anon, authenticated;
revoke all privileges on table public.tokens from public, anon, authenticated;
revoke all privileges on table public.daily_rows from public, anon, authenticated;

commit;

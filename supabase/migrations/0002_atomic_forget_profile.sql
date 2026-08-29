-- 0002: make account-wide Leave one atomic database operation and lock down
-- PostgREST privileges.
--
-- Requires 0001. Transactional and idempotent. It verifies the two cascades
-- before creating the function that relies on them; it never repairs an
-- unrecognised constraint by deleting/rebuilding data.

begin;
select pg_advisory_xact_lock(hashtext('wick-schema-migration'));

do $preconditions$
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
  invalid_hashes bigint;
  has_day_index boolean;
  has_token_email_index boolean;
  has_reviewed_hash_check boolean;
  constraints_validated boolean;
  ledger_constraints_validated boolean;
begin
  if to_regclass('public.wick_schema_migrations') is null then
    raise exception using
      message = 'Wick migration 0001 is required before 0002',
      hint = 'Run preflight, then apply migrations in filename order.';
  end if;

  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into ledger_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = to_regclass('public.wick_schema_migrations')
     and a.attnum > 0 and not a.attisdropped;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into ledger_constraints
    from pg_constraint
   where conrelid = to_regclass('public.wick_schema_migrations');
  select not exists (
    select 1 from pg_constraint
     where conrelid = to_regclass('public.wick_schema_migrations')
       and not convalidated
  ) into ledger_constraints_validated;

  if ledger_signature is distinct from
       'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()'
     or ledger_constraints is distinct from 'PRIMARY KEY (version)'
     or not ledger_constraints_validated then
    raise exception using
      message = 'Migration 0002 requires the exact reviewed migration ledger shape',
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
         ) and exists (
           select 1 from public.wick_schema_migrations
            where version = '0001'
              and description = 'token-key to email-key account schema'
         ) and not exists (
           select 1 from public.wick_schema_migrations where version = '0003'
         )
    into ledger_versions, ledger_content_valid
    from public.wick_schema_migrations;
  if not ledger_content_valid then
    raise exception using
      message = 'Migration 0002 requires exact ordered ledger entry 0001 and no later migration',
      detail = coalesce(ledger_versions, '<empty>'),
      hint = 'Unknown versions and conflicting descriptions are a hard stop; do not overwrite migration history.';
  end if;

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
  select not exists (
    select 1 from pg_constraint
     where conrelid in ('public.profiles'::regclass,
                        'public.tokens'::regclass,
                        'public.daily_rows'::regclass)
       and not convalidated
  ) into constraints_validated;

  select exists (
    select 1
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_am am on am.oid = idx.relam
     where i.indrelid = 'public.daily_rows'::regclass
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
     where i.indrelid = 'public.tokens'::regclass
       and idx.relnamespace = 'public'::regnamespace
       and idx.relname = 'tokens_email_idx'
       and am.amname = 'btree'
       and i.indisvalid and i.indisready and not i.indisunique
       and i.indnkeyatts = 1 and i.indnatts = 1
       and i.indpred is null and i.indexprs is null
       and pg_get_indexdef(i.indexrelid, 1, true) = 'email'
  ) into has_token_email_index;
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.tokens'::regclass
       and conname = 'tokens_token_hash_format'
       and contype = 'c' and convalidated
       and pg_get_constraintdef(oid) =
           'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))'
  ) into has_reviewed_hash_check;

  if profile_signature is distinct from
       'email:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE'
     or token_signature is distinct from
       'token_hash:text:t:,email:text:t:,created_on:date:t:CURRENT_DATE'
     or row_signature is distinct from
       'email:text:t:,day:date:t:,messages:integer:t:'
     or profile_constraints is distinct from
       'PRIMARY KEY (email)|UNIQUE (name_folded)'
     or row_constraints is distinct from
       'CHECK ((messages >= 0))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (email, day)'
     or not (
       token_constraints =
         'FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
       or (token_constraints =
         'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
         and has_reviewed_hash_check)
     )
     or not constraints_validated
     or not has_day_index or not has_token_email_index then
    raise exception using
      message = 'Migration 0002 requires the complete reviewed email-key shape',
      detail = format('profiles=(%s; %s), tokens=(%s; %s), daily_rows=(%s; %s), indexes=(day:%s, token_email:%s), constraints_validated=%s',
                      profile_signature, profile_constraints,
                      token_signature, token_constraints,
                      row_signature, row_constraints,
                      has_day_index, has_token_email_index,
                      constraints_validated),
      hint = 'Same column names are insufficient. Stop and inspect every type, default, constraint, and index.';
  end if;

  if exists (
    select 1
      from pg_class cls
      join pg_namespace ns on ns.oid = cls.relnamespace
      left join pg_policy pol on pol.polrelid = cls.oid
     where ns.nspname = 'public'
       and cls.relname in ('profiles', 'tokens', 'daily_rows',
                           'wick_schema_migrations')
       and (not cls.relrowsecurity or pol.oid is not null)
  ) then
    raise exception using
      message = 'Unexpected Wick RLS posture',
      hint = 'All Wick tables must already have RLS enabled with no policies. Inspect rather than silently repairing an unknown posture.';
  end if;

  select count(*) into invalid_hashes
    from public.tokens
   where token_hash !~ '^[0-9a-f]{64}$';
  if invalid_hashes <> 0 then
    raise exception using
      message = 'Existing token hashes violate the reviewed format',
      detail = format('invalid token hashes=%s', invalid_hashes),
      hint = 'Do not mutate credentials automatically. Investigate from the restorable backup.';
  end if;
end
$preconditions$;

-- Add and validate the format check without rewriting or deleting rows.
do $hash_constraint$
declare
  existing_definition text;
begin
  select pg_get_constraintdef(oid)
    into existing_definition
    from pg_constraint
   where conrelid = 'public.tokens'::regclass
     and conname = 'tokens_token_hash_format'
     and contype = 'c';

  if existing_definition is not null
     and existing_definition <>
         'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))' then
    raise exception using
      message = 'Existing tokens_token_hash_format constraint has an unreviewed definition',
      detail = existing_definition,
      hint = 'Do not validate or replace it automatically. Stop and inspect the schema provenance.';
  elsif existing_definition is null then
    alter table public.tokens
      add constraint tokens_token_hash_format
      check (token_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;
end
$hash_constraint$;
alter table public.tokens validate constraint tokens_token_hash_format;

alter table public.profiles enable row level security;
alter table public.tokens enable row level security;
alter table public.daily_rows enable row level security;
alter table public.wick_schema_migrations enable row level security;

create or replace function public.forget_profile(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  deleted_count integer;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  delete from public.profiles as profile
  using public.tokens as token
  where token.token_hash = p_token_hash
    and profile.email = token.email;

  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end
$function$;

revoke all privileges on schema public from public, anon, authenticated, service_role;
revoke all privileges on table public.profiles from public, anon, authenticated, service_role;
revoke all privileges on table public.tokens from public, anon, authenticated, service_role;
revoke all privileges on table public.daily_rows from public, anon, authenticated, service_role;
revoke all privileges on table public.wick_schema_migrations from public, anon, authenticated, service_role;
revoke all privileges on function public.forget_profile(text) from public, anon, authenticated, service_role;

grant usage on schema public to service_role;
grant select, insert on table public.profiles to service_role;
grant select, insert on table public.tokens to service_role;
grant select, insert, update on table public.daily_rows to service_role;
grant execute on function public.forget_profile(text) to service_role;

insert into public.wick_schema_migrations (version, description)
select '0002', 'atomic forget_profile and explicit privileges'
 where not exists (
   select 1 from public.wick_schema_migrations where version = '0002'
 );

commit;

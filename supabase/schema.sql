-- Wick leaderboard schema: final snapshot for a fresh database.
--
-- This file is idempotent only for a fresh database or one already at this
-- exact shape. It deliberately aborts on an earlier/unknown shape instead of
-- letting CREATE TABLE IF NOT EXISTS conceal incompatible columns. Existing
-- databases must run supabase/preflight.sql and the ordered migrations in
-- supabase/migrations/. Never use reset.sql as an upgrade path.
--
-- The database holds account emails. They are unverified identifiers, never
-- credentials. A daily row remains exactly a date and a message count.

begin;
select pg_advisory_xact_lock(hashtext('wick-schema-migration'));

create table if not exists public.wick_schema_migrations (
  version      text primary key,
  description  text not null,
  applied_at   timestamptz not null default statement_timestamp()
);

create table if not exists public.profiles (
  email        text primary key,
  name         text not null,
  name_folded  text not null unique,
  created_on   date not null default current_date
);

create table if not exists public.tokens (
  -- Only sha256(token), as 64 lowercase hexadecimal characters, is stored.
  token_hash  text primary key,
  email       text not null references public.profiles (email) on delete cascade,
  created_on  date not null default current_date,
  constraint tokens_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists tokens_email_idx on public.tokens (email);

create table if not exists public.daily_rows (
  email     text not null references public.profiles (email) on delete cascade,
  day       date not null,
  messages  integer not null check (messages >= 0),
  primary key (email, day)
);

-- There is intentionally no submission timestamp or other usage/account data.
create index if not exists daily_rows_day_idx on public.daily_rows (day);

-- CREATE IF NOT EXISTS is not a migration. Refuse to continue if it encountered
-- any shape other than the reviewed final snapshot.
do $shape_guard$
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
  has_day_index boolean;
  has_token_email_index boolean;
  constraints_validated boolean;
begin
  select string_agg(
           format('%s:%s:%s:%s', a.attname,
                  format_type(a.atttypid, a.atttypmod), a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), '')),
           ',' order by a.attnum)
    into profile_signature
    from pg_attribute a
    left join pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.profiles'::regclass
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
   where a.attrelid = 'public.tokens'::regclass
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
   where a.attrelid = 'public.daily_rows'::regclass
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
    into profile_constraints from pg_constraint
   where conrelid = 'public.profiles'::regclass;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into token_constraints from pg_constraint
   where conrelid = 'public.tokens'::regclass;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into row_constraints from pg_constraint
   where conrelid = 'public.daily_rows'::regclass;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into ledger_constraints from pg_constraint
   where conrelid = 'public.wick_schema_migrations'::regclass;
  select not exists (
    select 1 from pg_constraint
     where conrelid in ('public.profiles'::regclass,
                        'public.tokens'::regclass,
                        'public.daily_rows'::regclass,
                        'public.wick_schema_migrations'::regclass)
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

  if profile_signature is distinct from
       'email:text:t:,name:text:t:,name_folded:text:t:,created_on:date:t:CURRENT_DATE'
     or token_signature is distinct from
       'token_hash:text:t:,email:text:t:,created_on:date:t:CURRENT_DATE'
     or row_signature is distinct from
       'email:text:t:,day:date:t:,messages:integer:t:'
     or ledger_signature is distinct from
       'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()'
     or profile_constraints is distinct from
       'PRIMARY KEY (email)|UNIQUE (name_folded)'
     or token_constraints is distinct from
       'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
     or row_constraints is distinct from
       'CHECK ((messages >= 0))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (email, day)'
     or ledger_constraints is distinct from 'PRIMARY KEY (version)'
     or not constraints_validated
     or not has_day_index or not has_token_email_index then
    raise exception using
      message = 'Wick schema shape is not the reviewed current shape',
      detail = format('profiles=(%s; %s), tokens=(%s; %s), daily_rows=(%s; %s), ledger=(%s; %s), indexes=(day:%s, token_email:%s), constraints_validated=%s',
                      profile_signature, profile_constraints,
                      token_signature, token_constraints,
                      row_signature, row_constraints,
                      ledger_signature, ledger_constraints,
                      has_day_index, has_token_email_index,
                      constraints_validated),
      hint = 'Stop. Run supabase/preflight.sql and the ordered migrations; do not reset a populated database.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tokens'::regclass
       and conname = 'tokens_token_hash_format'
       and contype = 'c' and convalidated
       and pg_get_constraintdef(oid) =
           'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))'
  ) then
    raise exception using
      message = 'Wick token hash constraint is absent, unvalidated, or has an unreviewed definition',
      hint = 'Run the ordered migrations rather than treating schema.sql as an upgrade.';
  end if;

  select string_agg(format('%s:%s', version, description), '|' order by version),
         not exists (
           select 1 from public.wick_schema_migrations
            where not (
              (version = '0001' and description = 'token-key to email-key account schema')
              or (version = '0002' and description = 'atomic forget_profile and explicit privileges')
              or (version = '0003' and description = 'atomic enroll_profile and least-privilege writes')
            )
         ) and (
           not exists (select 1 from public.wick_schema_migrations)
           or (
             exists (select 1 from public.wick_schema_migrations where version = '0001')
             and exists (select 1 from public.wick_schema_migrations where version = '0002')
             and exists (select 1 from public.wick_schema_migrations where version = '0003')
           )
         )
    into ledger_versions, ledger_content_valid
    from public.wick_schema_migrations;

  if not ledger_content_valid then
    raise exception using
      message = 'Wick migration ledger has unknown, out-of-order, or conflicting entries',
      detail = coalesce(ledger_versions, '<empty>'),
      hint = 'Stop and inspect the ledger provenance; schema.sql never repairs or overwrites migration history.';
  end if;

  if exists (
    select 1 from pg_policy
     where polrelid in ('public.profiles'::regclass,
                        'public.tokens'::regclass,
                        'public.daily_rows'::regclass,
                        'public.wick_schema_migrations'::regclass)
  ) then
    raise exception using
      message = 'Unexpected Wick row-level security policy exists',
      hint = 'The reviewed posture is RLS enabled with no policies. Inspect the policy before changing it.';
  end if;
end
$shape_guard$;

-- RLS has no policies: direct data access is denied even if an anon or
-- authenticated key is exposed. The server-side adapter alone uses service_role.
alter table public.profiles enable row level security;
alter table public.tokens enable row level security;
alter table public.daily_rows enable row level security;
alter table public.wick_schema_migrations enable row level security;

-- One profile delete is the transaction boundary. The two verified ON DELETE
-- CASCADE constraints remove every token and daily row atomically. Unknown,
-- malformed, null, and already-used hashes are successful false results.
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

-- Profile lookup/creation and hashed-token binding are one function statement,
-- hence one transaction. A per-email lock makes concurrent first enrolments
-- converge before any candidate is inserted.
create or replace function public.enroll_profile(
  p_email text,
  p_name text,
  p_name_folded text,
  p_token_hash text
)
returns table(name text, existing boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  result_name text;
  result_folded text;
  was_existing boolean;
begin
  if p_email is null
     or char_length(p_email) > 254
     or p_email <> btrim(p_email)
     or p_email <> lower(p_email)
     or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or split_part(p_email, '@', 2) like '.%'
     or split_part(p_email, '@', 2) like '%.'
     or split_part(p_email, '@', 2) like '%..%'
     or p_email ~ '[[:cntrl:]]'
     or position(chr(8203) in p_email) <> 0
     or position(chr(8204) in p_email) <> 0
     or position(chr(8205) in p_email) <> 0
     or position(chr(8206) in p_email) <> 0
     or position(chr(8207) in p_email) <> 0
     or position(chr(8288) in p_email) <> 0
     or position(chr(65279) in p_email) <> 0 then
    raise exception using errcode = '22023', message = 'invalid enrollment email';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid enrollment token hash';
  end if;

  if (p_name is null) <> (p_name_folded is null) then
    raise exception using errcode = '22023', message = 'incomplete enrollment candidate';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_email, 0));

  select profile.name, profile.name_folded
    into result_name, result_folded
    from public.profiles as profile
   where profile.email = p_email;

  was_existing := found;
  if not was_existing then
    if p_name is null
       or p_name_folded is null
       or char_length(p_name) < 3
       or char_length(p_name) > 24
       or p_name !~ '^[a-z][a-z0-9_-]*[a-z0-9]$'
       or p_name ~ '[_-]{2}'
       or p_name_folded = ''
       or char_length(p_name_folded) > 24
       or p_name_folded <> lower(p_name_folded)
       or p_name_folded !~ '^[a-z][a-z0-9-]*[a-z0-9]$' then
      raise exception using errcode = '22023', message = 'invalid enrollment candidate';
    end if;

    begin
      insert into public.profiles (email, name, name_folded)
      values (p_email, p_name, p_name_folded);
    exception when unique_violation then
      if exists (
        select 1 from public.profiles as conflicting
         where conflicting.name_folded = p_name_folded
           and conflicting.email <> p_email
      ) then
        raise sqlstate 'PT409' using message = 'candidate name unavailable';
      end if;
      raise;
    end;

    result_name := p_name;
    result_folded := p_name_folded;
  end if;

  if result_name is null or result_name = ''
     or result_folded is null or result_folded = '' then
    raise exception using errcode = '55000', message = 'invalid enrollment profile state';
  end if;

  insert into public.tokens (token_hash, email)
  values (p_token_hash, p_email);

  return query select result_name, was_existing;
end
$function$;

do $function_guard$
declare
  enroll_count integer;
  enroll_valid boolean;
  forget_count integer;
  forget_valid boolean;
begin
  select count(*),
         coalesce(bool_and(routine.prosecdef
                  and routine.proretset
                  and routine.prokind = 'f'
                  and pg_get_function_result(routine.oid) =
                      'TABLE(name text, existing boolean)'
                  and routine.proconfig = array['search_path=pg_catalog, public']), false)
    into enroll_count, enroll_valid
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'enroll_profile'
     and pg_get_function_identity_arguments(routine.oid) =
         'p_email text, p_name text, p_name_folded text, p_token_hash text';

  select count(*),
         coalesce(bool_and(routine.prosecdef
                  and not routine.proretset
                  and routine.prokind = 'f'
                  and pg_get_function_result(routine.oid) = 'boolean'
                  and routine.proconfig = array['search_path=pg_catalog, public']), false)
    into forget_count, forget_valid
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'forget_profile'
     and pg_get_function_identity_arguments(routine.oid) = 'p_token_hash text';

  if enroll_count <> 1 or not enroll_valid
     or forget_count <> 1 or not forget_valid
     or exists (
       select 1 from pg_proc routine
       join pg_namespace ns on ns.oid = routine.pronamespace
       where ns.nspname = 'public'
         and (
           (routine.proname = 'enroll_profile'
            and pg_get_function_identity_arguments(routine.oid) <>
                'p_email text, p_name text, p_name_folded text, p_token_hash text')
           or (routine.proname = 'forget_profile'
               and pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text')
         )
     ) then
    raise exception using
      message = 'Enrollment RPCs do not have the reviewed SECURITY DEFINER shapes',
      hint = 'Do not grant execution. Stop and inspect every public overload.';
  end if;
end
$function_guard$;

-- Explicit ACLs. anon/authenticated get no table or function privilege. The
-- service role receives only what the current adapter invokes; deletion is
-- available solely through forget_profile, not direct DELETE grants.
revoke all privileges on schema public from public, anon, authenticated, service_role;
revoke all privileges on table public.profiles from public, anon, authenticated, service_role;
revoke all privileges on table public.tokens from public, anon, authenticated, service_role;
revoke all privileges on table public.daily_rows from public, anon, authenticated, service_role;
revoke all privileges on table public.wick_schema_migrations from public, anon, authenticated, service_role;
revoke all privileges on function public.forget_profile(text) from public, anon, authenticated, service_role;
revoke all privileges on function public.enroll_profile(text, text, text, text) from public, anon, authenticated, service_role;

grant usage on schema public to service_role;
grant select on table public.profiles to service_role;
grant select on table public.tokens to service_role;
grant select, insert, update on table public.daily_rows to service_role;
grant execute on function public.forget_profile(text) to service_role;
grant execute on function public.enroll_profile(text, text, text, text) to service_role;

insert into public.wick_schema_migrations (version, description)
select desired.version, desired.description
  from (values
    ('0001', 'token-key to email-key account schema'),
    ('0002', 'atomic forget_profile and explicit privileges'),
    ('0003', 'atomic enroll_profile and least-privilege writes')
  ) as desired(version, description)
 where not exists (
   select 1 from public.wick_schema_migrations existing
    where existing.version = desired.version
 );

commit;

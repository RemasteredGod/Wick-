-- 0003: make profile assignment and browser-token binding one atomic operation.
--
-- Requires 0001 and 0002. Transactional and idempotent. The adapter may read a
-- profile first to avoid proposing an unused name, but this function repeats the
-- decision under a per-email transaction lock and owns every enrolment mutation.

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
  has_day_index boolean;
  has_token_email_index boolean;
  has_reviewed_hash_check boolean;
  constraints_validated boolean;
  ledger_constraints_validated boolean;
  invalid_hashes bigint;
  enroll_overloads integer;
  forget_overloads integer;
begin
  if to_regclass('public.wick_schema_migrations') is null then
    raise exception using
      message = 'Wick migrations 0001 and 0002 are required before 0003',
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
   where a.attrelid = 'public.wick_schema_migrations'::regclass
     and a.attnum > 0 and not a.attisdropped;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into ledger_constraints
    from pg_constraint
   where conrelid = 'public.wick_schema_migrations'::regclass;
  select not exists (
    select 1 from pg_constraint
     where conrelid = 'public.wick_schema_migrations'::regclass
       and not convalidated
  ) into ledger_constraints_validated;

  if ledger_signature is distinct from
       'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()'
     or ledger_constraints is distinct from 'PRIMARY KEY (version)'
     or not ledger_constraints_validated then
    raise exception using
      message = 'Migration 0003 requires the exact reviewed migration ledger shape',
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
         )
         and exists (
           select 1 from public.wick_schema_migrations
            where version = '0001'
              and description = 'token-key to email-key account schema'
         )
         and exists (
           select 1 from public.wick_schema_migrations
            where version = '0002'
              and description = 'atomic forget_profile and explicit privileges'
         )
    into ledger_versions, ledger_content_valid
    from public.wick_schema_migrations;
  if not ledger_content_valid then
    raise exception using
      message = 'Migration 0003 requires exact ordered ledger entries 0001 and 0002',
      detail = coalesce(ledger_versions, '<empty>'),
      hint = 'Unknown versions, missing prefixes, and conflicting descriptions are a hard stop.';
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

  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into profile_constraints from pg_constraint
   where conrelid = 'public.profiles'::regclass;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into token_constraints from pg_constraint
   where conrelid = 'public.tokens'::regclass;
  select string_agg(pg_get_constraintdef(oid), '|' order by pg_get_constraintdef(oid))
    into row_constraints from pg_constraint
   where conrelid = 'public.daily_rows'::regclass;
  select not exists (
    select 1 from pg_constraint
     where conrelid in ('public.profiles'::regclass,
                        'public.tokens'::regclass,
                        'public.daily_rows'::regclass)
       and not convalidated
  ) into constraints_validated;

  select exists (
    select 1 from pg_index i
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
    select 1 from pg_index i
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
     or token_constraints is distinct from
       'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (token_hash)'
     or row_constraints is distinct from
       'CHECK ((messages >= 0))|FOREIGN KEY (email) REFERENCES profiles(email) ON DELETE CASCADE|PRIMARY KEY (email, day)'
     or not constraints_validated
     or not has_day_index or not has_token_email_index
     or not has_reviewed_hash_check then
    raise exception using
      message = 'Migration 0003 requires the complete reviewed email-key shape',
      detail = format('profiles=(%s; %s), tokens=(%s; %s), daily_rows=(%s; %s), indexes=(day:%s, token_email:%s), constraints_validated=%s',
                      profile_signature, profile_constraints,
                      token_signature, token_constraints,
                      row_signature, row_constraints,
                      has_day_index, has_token_email_index,
                      constraints_validated),
      hint = 'Stop and inspect every type, default, constraint, and index.';
  end if;

  if exists (
    select 1 from pg_class cls
    join pg_namespace ns on ns.oid = cls.relnamespace
    left join pg_policy pol on pol.polrelid = cls.oid
    where ns.nspname = 'public'
      and cls.relname in ('profiles', 'tokens', 'daily_rows',
                          'wick_schema_migrations')
      and (not cls.relrowsecurity or pol.oid is not null)
  ) then
    raise exception using
      message = 'Unexpected Wick RLS posture',
      hint = 'All Wick tables must have RLS enabled with no policies before 0003.';
  end if;

  select count(*) into invalid_hashes
    from public.tokens
   where token_hash !~ '^[0-9a-f]{64}$';
  if invalid_hashes <> 0 then
    raise exception using
      message = 'Existing token hashes violate the reviewed format',
      detail = format('invalid token hashes=%s', invalid_hashes),
      hint = 'Do not mutate credentials automatically. Investigate from the backup.';
  end if;

  select count(*) into enroll_overloads
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'enroll_profile'
     and pg_get_function_identity_arguments(routine.oid) <>
         'p_email text, p_name text, p_name_folded text, p_token_hash text';
  if enroll_overloads <> 0 then
    raise exception using
      message = 'Migration 0003 found an unreviewed enroll_profile overload',
      hint = 'Do not leave an alternate PostgREST RPC signature exposed. Stop and inspect provenance.';
  end if;

  select count(*) into forget_overloads
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'forget_profile'
     and pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text';
  if forget_overloads <> 0 then
    raise exception using
      message = 'Migration 0003 found an unreviewed forget_profile overload',
      hint = 'Do not leave an alternate PostgREST RPC signature exposed. Stop and inspect provenance.';
  end if;
end
$preconditions$;

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

  -- Every first enrolment for one account reaches the existence decision in a
  -- single-file line. A winner commits one profile; waiters then use its exact
  -- name and only add their own browser token.
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
        -- PT409 is PostgREST's explicit HTTP-status SQLSTATE. The adapter
        -- retries this code only; other uniqueness failures remain failures.
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

  -- This is in the same function transaction as the profile insert. Any token
  -- constraint, storage, or server failure rolls back a newly stored email.
  insert into public.tokens (token_hash, email)
  values (p_token_hash, p_email);

  return query select result_name, was_existing;
end
$function$;

-- Reject unexpected function shapes before opening either ACL to PostgREST.
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
     or forget_count <> 1 or not forget_valid then
    raise exception using
      message = 'Enrollment RPCs do not have the reviewed SECURITY DEFINER shapes',
      hint = 'Do not grant execution. Stop and inspect both function definitions.';
  end if;
end
$function_guard$;

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
select '0003', 'atomic enroll_profile and least-privilege writes'
 where not exists (
   select 1 from public.wick_schema_migrations where version = '0003'
 );

commit;

-- Wick Supabase upgrade preflight (read-only).
--
-- Run and save the complete output before any migration. It reports metadata
-- and aggregate counts only: no email, name, token hash, or daily value is
-- selected. It changes nothing. An exception means stop; never answer it with
-- reset.sql, DROP, TRUNCATE, or an ad-hoc data rewrite.

-- Shape report.
select c.table_name,
       string_agg(c.column_name || ' ' || c.data_type,
                  ', ' order by c.ordinal_position) as columns
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.table_name in ('profiles', 'tokens', 'daily_rows',
                        'wick_schema_migrations')
 group by c.table_name
 order by c.table_name;

-- Constraints, including ON DELETE actions. confdeltype=c means CASCADE.
select con.conrelid::regclass::text as table_name,
       con.conname as constraint_name,
       con.contype as constraint_type,
       con.confdeltype as delete_action,
       con.convalidated as validated,
       pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
 where con.conrelid in (
   select cls.oid
     from pg_class cls
     join pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public'
      and cls.relname in ('profiles', 'tokens', 'daily_rows',
                          'wick_schema_migrations')
 )
 order by table_name, constraint_name;

-- RLS and policy report. The reviewed final posture is row_security=true and
-- zero policy rows for all four tables.
select cls.relname as table_name,
       cls.relrowsecurity as row_security,
       cls.relforcerowsecurity as force_row_security,
       count(pol.oid) as policy_count
  from pg_class cls
  join pg_namespace ns on ns.oid = cls.relnamespace
  left join pg_policy pol on pol.polrelid = cls.oid
 where ns.nspname = 'public'
   and cls.relname in ('profiles', 'tokens', 'daily_rows',
                       'wick_schema_migrations')
 group by cls.relname, cls.relrowsecurity, cls.relforcerowsecurity
 order by cls.relname;

-- Effective schema ACL report for API roles.
select role_name,
       has_schema_privilege(role_name::name, 'public', 'USAGE') as can_use_schema,
       has_schema_privilege(role_name::name, 'public', 'CREATE') as can_create_in_schema
  from unnest(array['anon', 'authenticated', 'service_role']) as roles(role_name)
 order by role_name;

-- Effective ACL report for API roles. This reports booleans rather than data.
select role_name,
       object_name,
       has_table_privilege(role_name::name, 'public.' || object_name, 'SELECT') as can_select,
       has_table_privilege(role_name::name, 'public.' || object_name, 'INSERT') as can_insert,
       has_table_privilege(role_name::name, 'public.' || object_name, 'UPDATE') as can_update,
       has_table_privilege(role_name::name, 'public.' || object_name, 'DELETE') as can_delete
  from unnest(array['anon', 'authenticated', 'service_role']) as roles(role_name)
 cross join unnest(array['profiles', 'tokens', 'daily_rows',
                         'wick_schema_migrations']) as objects(object_name)
 where to_regclass('public.' || object_name) is not null
 order by role_name, object_name;

select routine.oid::regprocedure::text as function_name,
       has_function_privilege('anon', routine.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', routine.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', routine.oid, 'EXECUTE') as service_role_execute
  from pg_proc routine
  join pg_namespace ns on ns.oid = routine.pronamespace
 where ns.nspname = 'public'
   and routine.proname in ('enroll_profile', 'forget_profile')
 order by function_name;

-- Each RPC may be absent before its installing migration; once present, no
-- overload or altered SECURITY DEFINER/result/search-path shape is accepted.
do $rpc_function_guard$
declare
  enroll_count integer;
  enroll_valid boolean;
  enroll_overloads integer;
  forget_count integer;
  forget_valid boolean;
  forget_overloads integer;
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

  select count(*) into enroll_overloads
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'enroll_profile'
     and pg_get_function_identity_arguments(routine.oid) <>
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

  select count(*) into forget_overloads
    from pg_proc routine
    join pg_namespace ns on ns.oid = routine.pronamespace
   where ns.nspname = 'public'
     and routine.proname = 'forget_profile'
     and pg_get_function_identity_arguments(routine.oid) <> 'p_token_hash text';

  if enroll_overloads <> 0 or enroll_count > 1
     or (enroll_count = 1 and not enroll_valid)
     or forget_overloads <> 0 or forget_count > 1
     or (forget_count = 1 and not forget_valid) then
    raise exception using
      message = 'PREFLIGHT BLOCKED: unreviewed enrollment RPC shape or overload',
      hint = 'PostgREST must expose only the reviewed SECURITY DEFINER signatures. Stop and inspect provenance.';
  end if;
end
$rpc_function_guard$;

-- Migration ledger is optional before 0001. If present, it must be exactly the
-- reviewed table and contain only an ordered prefix of the known migrations.
do $ledger_guard$
declare
  ledger_signature text;
  ledger_constraints text;
  ledger_versions text;
  ledger_content_valid boolean;
  constraints_validated boolean;
  reviewed_rls boolean;
begin
  if to_regclass('public.wick_schema_migrations') is null then
    raise notice 'migration ledger=absent';
    return;
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
  ) into constraints_validated;
  select cls.relrowsecurity and not exists (
           select 1 from pg_policy pol where pol.polrelid = cls.oid
         )
    into reviewed_rls
    from pg_class cls
   where cls.oid = to_regclass('public.wick_schema_migrations');

  if ledger_signature is distinct from
       'version:text:t:,description:text:t:,applied_at:timestamp with time zone:t:statement_timestamp()'
     or ledger_constraints is distinct from 'PRIMARY KEY (version)'
     or not constraints_validated
     or not reviewed_rls then
    raise exception using
      message = 'PREFLIGHT BLOCKED: unknown migration ledger shape or RLS posture',
      detail = format('ledger=(%s; %s), constraints_validated=%s, reviewed_rls=%s',
                      ledger_signature, ledger_constraints,
                      constraints_validated, reviewed_rls),
      hint = 'Extra or missing columns/defaults/constraints are not reviewed history. Stop and inspect provenance.';
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
      message = 'PREFLIGHT BLOCKED: unknown, out-of-order, or conflicting migration ledger entries',
      detail = ledger_versions,
      hint = 'Do not overwrite migration history. Preserve output and inspect provenance.';
  end if;

  raise notice 'migration ledger versions=%', coalesce(ledger_versions, '<empty>');
end
$ledger_guard$;

-- Report exact reviewed ledger rows only after the guard above makes the
-- projection safe. Values contain no participant data.
do $ledger_report$
declare
  migration record;
begin
  if to_regclass('public.wick_schema_migrations') is null then
    raise notice 'migration ledger=absent';
    return;
  end if;

  for migration in execute
    'select version, description, applied_at from public.wick_schema_migrations order by version'
  loop
    raise notice 'migration version=% description=% applied_at=%',
                 migration.version, migration.description, migration.applied_at;
  end loop;
end
$ledger_report$;

-- Exact aggregate counts and safety gate. Dynamic SQL allows this file to
-- inspect either known shape without parse failures for a table that does not
-- exist. NOTICE output is part of the preflight evidence.
do $preflight$
declare
  profile_signature text;
  token_signature text;
  row_signature text;
  profile_constraints text;
  token_constraints text;
  row_constraints text;
  ledger_versions text;
  profile_count bigint;
  token_count bigint;
  row_count bigint;
  orphan_tokens bigint := 0;
  orphan_rows bigint := 0;
  invalid_hashes bigint := 0;
  has_day_index boolean;
  has_token_email_index boolean;
  has_reviewed_hash_check boolean;
  constraints_validated boolean;
  reviewed_rls boolean;
  is_legacy boolean;
  is_current boolean;
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
     where conrelid in (to_regclass('public.profiles'),
                        to_regclass('public.tokens'),
                        to_regclass('public.daily_rows'))
       and not convalidated
  ) into constraints_validated;
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
  select count(*) = 0
    into reviewed_rls
    from pg_class cls
    join pg_namespace ns on ns.oid = cls.relnamespace
    left join pg_policy pol on pol.polrelid = cls.oid
   where ns.nspname = 'public'
     and cls.relname in ('profiles', 'tokens', 'daily_rows')
     and (not cls.relrowsecurity or pol.oid is not null);

  if to_regclass('public.wick_schema_migrations') is not null then
    execute $sql$
      select string_agg(format('%s:%s', version, description), '|' order by version)
        from public.wick_schema_migrations
    $sql$ into ledger_versions;
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

  if not is_legacy and not is_current then
    raise exception using
      message = 'PREFLIGHT BLOCKED: unknown Wick schema shape',
      detail = format('profiles=(%s; %s), tokens=(%s; %s), daily_rows=(%s; %s), indexes=(day:%s, token_email:%s), constraints_validated=%s, reviewed_rls=%s',
                      profile_signature, profile_constraints,
                      token_signature, token_constraints,
                      row_signature, row_constraints,
                      has_day_index, has_token_email_index,
                      constraints_validated, reviewed_rls),
      hint = 'Preserve output and backup; do not reset, drop, or guess a migration.';
  end if;

  execute 'select count(*) from public.profiles' into profile_count;
  execute 'select count(*) from public.daily_rows' into row_count;

  if is_legacy then
    raise notice 'shape=legacy-token-key profiles=% daily_rows=%',
                 profile_count, row_count;
    if ledger_versions is not null then
      raise exception using
        message = 'PREFLIGHT BLOCKED: legacy shape has impossible migration ledger history',
        detail = ledger_versions,
        hint = 'Migration 0001 cannot be recorded before its legacy-to-current rename commits. Stop and inspect provenance.';
    end if;
    if profile_count <> 0 or row_count <> 0 then
      raise exception using
        message = 'PREFLIGHT BLOCKED: populated legacy token-key schema',
        detail = format('profiles=%s, daily_rows=%s; no account email exists to migrate',
                        profile_count, row_count),
        hint = 'Keep the restorable backup and obtain an owner-approved identity/re-enrolment decision.';
    end if;
    raise notice 'PREFLIGHT SAFE FOR STAGING: empty exact legacy shape can run 0001 then 0002 then 0003';
    return;
  end if;

  execute 'select count(*) from public.tokens' into token_count;
  execute $sql$
    select count(*) from public.tokens token
    left join public.profiles profile on profile.email = token.email
    where profile.email is null
  $sql$ into orphan_tokens;
  execute $sql$
    select count(*) from public.daily_rows row_data
    left join public.profiles profile on profile.email = row_data.email
    where profile.email is null
  $sql$ into orphan_rows;
  execute $sql$
    select count(*) from public.tokens
    where token_hash !~ '^[0-9a-f]{64}$'
  $sql$ into invalid_hashes;

  raise notice 'shape=current-email-key profiles=% tokens=% daily_rows=% orphan_tokens=% orphan_rows=% invalid_hashes=%',
               profile_count, token_count, row_count, orphan_tokens, orphan_rows,
               invalid_hashes;

  if orphan_tokens <> 0 or orphan_rows <> 0 or invalid_hashes <> 0 then
    raise exception using
      message = 'PREFLIGHT BLOCKED: current data violates migration assumptions',
      detail = format('orphan_tokens=%s, orphan_rows=%s, invalid_hashes=%s',
                      orphan_tokens, orphan_rows, invalid_hashes),
      hint = 'Stop and investigate from the backup; no migration deletes or repairs these rows.';
  end if;

  raise notice 'PREFLIGHT SAFE FOR STAGING: exact current shape can run ordered migrations';
end
$preflight$;

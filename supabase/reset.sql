-- Local-development reset only.
--
-- This file is not a migration and must never be run against production or a
-- database whose rows matter. Production upgrades use the ordered files in
-- supabase/migrations/ after supabase/preflight.sql, a restorable backup, a
-- staging rehearsal, and explicit owner confirmation.
--
-- It fails closed. A local operator must deliberately run this in the same
-- session first:
--
--   set wick.allow_destructive_reset = 'local-development-only';
--
-- The setting is not permission to use this against production. It only makes
-- accidental execution (including pasting the file into the SQL editor) stop
-- before the first DROP.

do $guard$
begin
  if current_setting('wick.allow_destructive_reset', true)
       is distinct from 'local-development-only' then
    raise exception using
      message = 'destructive reset disabled',
      hint = 'Use ordered migrations. Only a disposable local database may set wick.allow_destructive_reset.';
  end if;
end
$guard$;

-- Child tables are named explicitly so a malformed local schema can still be
-- cleared. CASCADE is appropriate only because the guard above limits this file
-- to a disposable database.
drop table if exists public.daily_rows cascade;
drop table if exists public.tokens cascade;
drop table if exists public.profiles cascade;
drop table if exists public.wick_schema_migrations cascade;

-- Obsolete pre-leaderboard development tables.
drop table if exists public.connections cascade;
drop table if exists public.codes cascade;
drop table if exists public.rename_codes cascade;

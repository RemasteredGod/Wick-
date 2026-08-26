-- Drop the previous tables, then rebuild.
--
-- `supabase/schema.sql` uses `create table if not exists`, which is right for a
-- fresh project and silently does nothing to an existing one. Any deployment
-- that ran an earlier schema has tables with different columns, so re-running
-- the new schema leaves them untouched and every request then fails against
-- columns that are not there:
--
--   /board, /u/<name>   PostgREST 400 on `select=email,name`  -> 503
--   /api/enroll         400 inserting `email`                 -> 503
--   /api/submit         400 inserting `email`                 -> 503
--
-- This drops them instead. **It destroys every row**, which is the right trade
-- only while the board is empty or seeded — check `/board` first. A deployment
-- with real participants needs an `alter table` migration written against what
-- it actually holds, not this.
--
-- Run this, then supabase/schema.sql, then optionally supabase/seed.sql.

-- Current tables. `tokens` and `daily_rows` cascade from `profiles`, but they
-- are named explicitly so this works on a database somebody rebuilt by hand
-- without the foreign keys.
drop table if exists daily_rows cascade;
drop table if exists tokens cascade;
drop table if exists profiles cascade;

-- Gone with the Telegram bot: connections mapped bot tokens to chats, codes
-- held the ten-minute connect codes, rename_codes held proof of a payment.
-- Nothing reads any of them.
drop table if exists connections cascade;
drop table if exists codes cascade;
drop table if exists rename_codes cascade;

-- Drop the Telegram-era tables, then rebuild.
--
-- `supabase/schema.sql` uses `create table if not exists`, which is right for a
-- fresh project and silently does nothing to an existing one. A deployment that
-- ran the old schema already has `profiles` keyed on `chat_id` and `daily_rows`
-- with four token columns, so re-running the new schema leaves both untouched
-- and every request then fails against columns that are not there:
--
--   /board, /u/<name>   PostgREST 400 on `select=token_hash,name` -> 503
--   /api/enroll         400 inserting `token_hash`                -> 503
--
-- This drops them instead. **It destroys every row**, which is the right trade
-- only while the board is empty — check `/board` says "No submissions" first.
-- A deployment with real participants needs an `alter table` migration written
-- against what it actually holds, not this.
--
-- Run this, then supabase/schema.sql, then optionally supabase/seed.sql.

drop table if exists daily_rows cascade;
drop table if exists profiles cascade;

-- Gone with the Telegram bot: connections mapped bot tokens to chats, codes
-- held the ten-minute connect codes, rename_codes held proof of a payment.
-- Nothing reads any of them.
drop table if exists connections cascade;
drop table if exists codes cascade;
drop table if exists rename_codes cascade;

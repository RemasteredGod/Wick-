-- Remove the development seed.
--
-- Deletes exactly the five accounts supabase/seed.sql inserted, by email.
--
-- Every seeded address is under `@wick.invalid`, which RFC 2606 reserves so it
-- can never be a real mailbox — so this cannot take a real participant with it,
-- even if somebody were later assigned one of the same public names. Deleting by
-- name could: the board assigns names at random from the same word list the seed
-- drew from.
--
-- `tokens.email` and `daily_rows.email` reference `profiles` with `on delete
-- cascade`, so both would go with the profiles anyway. The explicit deletes run
-- first regardless: they cost nothing, and they do not depend on the constraint
-- being present in a database somebody rebuilt by hand.
--
-- Safe to run twice — deleting nothing is not an error — and safe to run against
-- a board with real participants on it.

delete from daily_rows where email in (
  'amber@wick.invalid',
  'quiet@wick.invalid',
  'slate@wick.invalid',
  'copper@wick.invalid',
  'willow@wick.invalid'
);

delete from tokens where email in (
  'amber@wick.invalid',
  'quiet@wick.invalid',
  'slate@wick.invalid',
  'copper@wick.invalid',
  'willow@wick.invalid'
);

delete from profiles where email in (
  'amber@wick.invalid',
  'quiet@wick.invalid',
  'slate@wick.invalid',
  'copper@wick.invalid',
  'willow@wick.invalid'
);

-- Wick leaderboard: a development seed.
--
-- **Not for production.** Five invented accounts with a week of invented days.
-- The board labels every figure self-reported, but a public board carrying rows
-- nobody submitted is a different claim, so take them out before real people
-- join — supabase/unseed.sql does exactly that.
--
-- The addresses are all `@wick.invalid`. RFC 2606 reserves `.invalid` precisely
-- so a made-up address cannot collide with a real mailbox: nobody can ever sign
-- into claude.ai with one of these, so a seeded profile can never be mistaken
-- for, or block, a real account.
--
-- Token hashes are sha256 of the plaintext tokens. Folded names come from
-- `fold` in leaderboard/names.ts — note 0 to o, 1 to l, 3 to e, 5 to s, which is
-- why they look misspelled. Do not hand-edit either: the server recomputes both,
-- and a value that disagrees makes a profile unreachable by its own token.
--
-- Who is who, and the tokens to test a real submit with:
--
--   name                  email               token
--   amber-ledger-0042     amber@wick.invalid  wick-seed-amber-2f8c41d9e6b7
--   quiet-harbour-7781    quiet@wick.invalid  wick-seed-quiet-7a1e93c4f0d2
--   slate-meadow-0031     slate@wick.invalid  wick-seed-slate-b53d08a7e91c
--   copper-thistle-5520   copper@wick.invalid wick-seed-copper-4e7f2b6d1a83
--   willow-lantern-1187   willow@wick.invalid wick-seed-willow-9c02a5e83f14
--
-- Apply after supabase/schema.sql.

insert into profiles (email, name, name_folded) values
  ('amber@wick.invalid', 'amber-ledger-0042', 'amber-ledger-oo42'),
  ('quiet@wick.invalid', 'quiet-harbour-7781', 'quiet-harbour-778l'),
  ('slate@wick.invalid', 'slate-meadow-0031', 'slate-meadow-ooel'),
  ('copper@wick.invalid', 'copper-thistle-5520', 'copper-thistle-ss2o'),
  ('willow@wick.invalid', 'willow-lantern-1187', 'willow-lantern-ll87');

insert into tokens (token_hash, email) values
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', 'amber@wick.invalid'),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', 'quiet@wick.invalid'),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', 'slate@wick.invalid'),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', 'copper@wick.invalid'),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', 'willow@wick.invalid');

insert into daily_rows (email, day, messages) values
  ('amber@wick.invalid', '2026-08-25', 41),
  ('amber@wick.invalid', '2026-08-24', 63),
  ('amber@wick.invalid', '2026-08-23', 12),
  ('amber@wick.invalid', '2026-08-22', 58),
  ('amber@wick.invalid', '2026-08-21', 77),
  ('amber@wick.invalid', '2026-08-20', 34),
  ('amber@wick.invalid', '2026-08-19', 49),
  ('quiet@wick.invalid', '2026-08-25', 22),
  ('quiet@wick.invalid', '2026-08-24', 30),
  ('quiet@wick.invalid', '2026-08-23', 45),
  ('quiet@wick.invalid', '2026-08-22', 19),
  ('quiet@wick.invalid', '2026-08-21', 27),
  ('quiet@wick.invalid', '2026-08-20', 51),
  ('quiet@wick.invalid', '2026-08-19', 38),
  ('slate@wick.invalid', '2026-08-25', 8),
  ('slate@wick.invalid', '2026-08-24', 0),
  ('slate@wick.invalid', '2026-08-23', 15),
  ('slate@wick.invalid', '2026-08-22', 23),
  ('slate@wick.invalid', '2026-08-21', 11),
  ('slate@wick.invalid', '2026-08-20', 6),
  ('slate@wick.invalid', '2026-08-19', 19),
  ('copper@wick.invalid', '2026-08-25', 66),
  ('copper@wick.invalid', '2026-08-24', 71),
  ('copper@wick.invalid', '2026-08-23', 58),
  ('copper@wick.invalid', '2026-08-22', 90),
  ('copper@wick.invalid', '2026-08-21', 44),
  ('copper@wick.invalid', '2026-08-20', 62),
  ('copper@wick.invalid', '2026-08-19', 73),
  ('willow@wick.invalid', '2026-08-25', 5),
  ('willow@wick.invalid', '2026-08-24', 12),
  ('willow@wick.invalid', '2026-08-23', 0),
  ('willow@wick.invalid', '2026-08-22', 9),
  ('willow@wick.invalid', '2026-08-21', 14),
  ('willow@wick.invalid', '2026-08-20', 3),
  ('willow@wick.invalid', '2026-08-19', 7);

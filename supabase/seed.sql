-- Wick leaderboard: a development seed.
--
-- **Not for production.** These are five invented participants with a week of
-- invented days. The board labels every figure self-reported, but a public
-- board carrying rows nobody submitted is a different claim, so drop them
-- before real people join:
--
--     delete from profiles where name_folded like '%-oo42' or token_hash in (...);
--
-- or simply re-run supabase/schema.sql's drop-and-recreate.
--
-- The token hashes below are sha256 of the plaintext tokens listed at the
-- bottom, computed with `hashToken` from server/supabase-store.ts. The folded
-- names come from `fold` in leaderboard/names.ts — note `0`→`o`, `1`→`l`,
-- `3`→`e`, `5`→`s`, which is why they look misspelled. Do not hand-edit either
-- column: the server recomputes both, and a value that disagrees makes a
-- profile unreachable by its own token.
--
-- Apply after supabase/schema.sql.

insert into profiles (token_hash, name, name_folded) values
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', 'amber-ledger-0042', 'amber-ledger-oo42'),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', 'quiet-harbour-7781', 'quiet-harbour-778l'),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', 'slate-meadow-0031', 'slate-meadow-ooel'),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', 'copper-thistle-5520', 'copper-thistle-ss2o'),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', 'willow-lantern-1187', 'willow-lantern-ll87');

insert into daily_rows (token_hash, day, messages) values
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-25', 41),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-24', 63),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-23', 12),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-22', 58),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-21', 77),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-20', 34),
  ('eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64', '2026-08-19', 49),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-25', 22),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-24', 30),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-23', 45),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-22', 19),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-21', 27),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-20', 51),
  ('f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c', '2026-08-19', 38),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-25', 8),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-24', 0),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-23', 15),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-22', 23),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-21', 11),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-20', 6),
  ('403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21', '2026-08-19', 19),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-25', 66),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-24', 71),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-23', 58),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-22', 90),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-21', 44),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-20', 62),
  ('a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0', '2026-08-19', 73),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-25', 5),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-24', 12),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-23', 0),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-22', 9),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-21', 14),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-20', 3),
  ('09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525', '2026-08-19', 7);

-- plaintext tokens, for testing a real submit:
-- amber-ledger-0042      wick-seed-amber-2f8c41d9e6b7
-- quiet-harbour-7781     wick-seed-quiet-7a1e93c4f0d2
-- slate-meadow-0031      wick-seed-slate-b53d08a7e91c
-- copper-thistle-5520    wick-seed-copper-4e7f2b6d1a83
-- willow-lantern-1187    wick-seed-willow-9c02a5e83f14

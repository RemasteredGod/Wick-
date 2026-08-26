-- Remove the development seed.
--
-- Deletes exactly the five participants supabase/seed.sql inserted, by token
-- hash. **Keyed on the hash, not the name**: a name is a value a real
-- participant could hold, and the board assigns names at random from the same
-- word list the seed drew from, so `where name like 'amber-%'` would eventually
-- take somebody real with it.
--
-- `daily_rows.token_hash` references `profiles` with `on delete cascade`, so
-- the rows would go with the profiles anyway. The explicit delete runs first
-- regardless: it costs nothing, and it does not depend on the constraint being
-- present in a database somebody rebuilt by hand.
--
-- Safe to run twice — deleting nothing is not an error — and safe to run
-- against a board with real participants on it, which is the point of keying it
-- this way.

delete from daily_rows where token_hash in (
  'eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64',  -- amber-ledger-0042
  'f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c',  -- quiet-harbour-7781
  '403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21',  -- slate-meadow-0031
  'a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0',  -- copper-thistle-5520
  '09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525'  -- willow-lantern-1187
);

delete from profiles where token_hash in (
  'eb51e6c55a5143b70a469c465db935319d4f2ffac24b7ffdf40faf4d49eb2b64',  -- amber-ledger-0042
  'f9b59224a9e95cbad72175a63983f2259504d664aca8c8b55f28fafa130dbb7c',  -- quiet-harbour-7781
  '403b54c0bd9fb00d235d6acd6f5d093a652880854a05479fa08c42aa70f8cb21',  -- slate-meadow-0031
  'a755bdb4043de9bd23ec016a050860881395eba656bdc68119731d65c291fca0',  -- copper-thistle-5520
  '09b484c2fa848ffe215cc70122e5e3633c83e5d9e8c55620b47f011705579525'  -- willow-lantern-1187
);

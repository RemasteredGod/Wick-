-- Wick leaderboard schema.
--
-- Every column exists because something reads it. What is *absent* is as
-- deliberate as what is here, so the notable omissions are called out inline
-- rather than left for someone to helpfully add later.
--
-- Two tables, and that is the whole database. The Telegram-era schema had five:
-- `connections` mapped bot tokens to chats, `codes` held the short-lived
-- connect codes, and `rename_codes` held proof of a payment. Enrolment happens
-- from the extension now — one token is one participant — so there is nothing
-- to reconcile a chat against and no code to exchange for anything.
--
-- Apply with: supabase db push, or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- Profiles: one per participant token.
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  -- The token itself is never stored. A stolen database must not yield working
  -- credentials, so this is sha256(token) and the server hashes on the way in.
  -- It is also the identity: there is no account, no email and no handle, and
  -- nothing here can recover a lost token. That is the point.
  token_hash   text primary key,
  name         text not null,
  -- The confusable-folded form. Uniqueness is decided on this, never on `name`,
  -- or `ash`, `Ash`, `a5h` and `as_h` become four rows that read as one person.
  --
  -- Load-bearing beyond display: enrolment inserts a proposed name and lets
  -- this constraint reject the collision, rather than reading first and then
  -- writing. Drop the uniqueness and two concurrent joins can take one name.
  name_folded  text not null unique,
  created_on   date not null default current_date
);

-- ---------------------------------------------------------------------------
-- Daily rows: the leaderboard's only usage data.
-- ---------------------------------------------------------------------------

create table if not exists daily_rows (
  token_hash  text not null references profiles (token_hash) on delete cascade,
  -- A local calendar day as the extension saw it. Not converted, because the
  -- server never learns the submitter's timezone and has nothing to convert
  -- with.
  day         date not null,
  -- Messages sent that day. **This is the only usage figure the board holds.**
  -- Not percentages, which do not compare across plans; not tokens, which the
  -- extension cannot count and is forbidden from estimating; and not times of
  -- day, which it records locally and never sends.
  messages    integer not null check (messages >= 0),

  -- The composite key is load-bearing. A resubmission *replaces* the day rather
  -- than adding to it, so a retried request corrects a total instead of
  -- inflating it. Upsert on conflict, never insert.
  primary key (token_hash, day)
);

-- **No created_at on this table, on purpose.** Supabase's table editor adds one
-- by default. Here it would turn a daily aggregate into a record of exactly when
-- somebody was working, which is the one thing the board promises not to keep.

create index if not exists daily_rows_day_idx on daily_rows (day);

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
--
-- Enabled with **no policies at all**, which denies everything. Authorisation
-- happens in the serverless functions, which hold the service-role key and
-- bypass RLS; the board's identity model is possession of a bearer token whose
-- hash is a primary key, and RLS cannot express that.
--
-- So this is defence in depth rather than the access control itself: if the
-- anon key ever leaks, or is pasted into client code by accident, it yields
-- nothing instead of the entire leaderboard.

alter table profiles    enable row level security;
alter table daily_rows  enable row level security;

-- Wick relay schema.
--
-- Every column exists because something reads it. What is *absent* is as
-- deliberate as what is here, so the notable omissions are called out inline
-- rather than left for someone to helpfully add later.
--
-- Apply with: supabase db push, or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- Connections: the address book.
-- ---------------------------------------------------------------------------

create table if not exists connections (
  -- The token itself is never stored. A stolen database must not yield working
  -- credentials, so this is sha256(token) and the relay hashes on the way in.
  token_hash  text primary key,
  chat_id     bigint not null,
  -- Day granularity, deliberately. A precise timestamp on a row that is touched
  -- whenever an alert is sent would be a log of when the user was working.
  created_on  date not null default current_date,
  last_used_on date not null default current_date
);

create index if not exists connections_chat_id_idx on connections (chat_id);

-- ---------------------------------------------------------------------------
-- Codes: short-lived, single-use, and destroyed after five guesses.
-- ---------------------------------------------------------------------------

create table if not exists codes (
  code       text primary key,
  chat_id    bigint not null,
  minted_at  timestamptz not null default now(),
  -- Five, then the row is deleted. This is the real defence against guessing an
  -- eight-character code: it makes the size of the search space irrelevant.
  attempts   smallint not null default 0
);

-- A timestamp is acceptable here and nowhere else: a code lives ten minutes and
-- is deleted on redemption, so it never becomes a history of anything.
create index if not exists codes_minted_at_idx on codes (minted_at);

-- ---------------------------------------------------------------------------
-- Profiles: one per chat, however many installations it has.
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  chat_id      bigint primary key,
  name         text not null,
  -- The confusable-folded form. Uniqueness is decided on this, never on `name`,
  -- or `ash`, `Ash`, `a5h` and `as_h` become four rows that read as one person.
  name_folded  text not null unique,
  digest       boolean not null default false,
  created_on   date not null default current_date
);

-- ---------------------------------------------------------------------------
-- Daily rows: the leaderboard's only usage data.
-- ---------------------------------------------------------------------------

create table if not exists daily_rows (
  token_hash      text not null,
  -- A local calendar day as the reporter saw it. Not converted, because the
  -- relay never learns the submitter's timezone and has nothing to convert with.
  day             date not null,
  input           bigint not null,
  output          bigint not null,
  cache_creation  bigint not null,
  cache_read      bigint not null,
  sessions        integer not null,

  -- The composite key is load-bearing. A resubmission *replaces* the day rather
  -- than adding to it, so a retried hook corrects a total instead of inflating
  -- it. Upsert on conflict, never insert.
  primary key (token_hash, day)
);

-- **No created_at on this table, on purpose.** Supabase's table editor adds one
-- by default. Here it would turn a daily aggregate into a record of exactly when
-- somebody was working, which is the one thing the relay promises not to keep.

create index if not exists daily_rows_day_idx on daily_rows (day);

-- ---------------------------------------------------------------------------
-- Rename codes: proof of payment, holding no payment identity.
-- ---------------------------------------------------------------------------

create table if not exists rename_codes (
  code         text primary key,
  redeemed     boolean not null default false,
  created_on   date not null default current_date,
  -- The processor's session id, kept only long enough to answer a chargeback.
  -- It is NOT joined to a profile and must never be: the anonymity argument
  -- rests on nothing connecting a payment to a name. Delete on the schedule the
  -- privacy policy states.
  payment_ref  text
);

-- ---------------------------------------------------------------------------
-- Row level security.
-- ---------------------------------------------------------------------------
--
-- Enabled with **no policies at all**, which denies everything. Authorisation
-- happens in the serverless functions, which hold the service-role key and
-- bypass RLS; the relay's identity model is possession of a bearer token bound
-- to a Telegram chat, and RLS cannot express that.
--
-- So this is defence in depth rather than the access control itself: if the
-- anon key ever leaks, or is pasted into client code by accident, it yields
-- nothing instead of the entire leaderboard.

alter table connections   enable row level security;
alter table codes         enable row level security;
alter table profiles      enable row level security;
alter table daily_rows    enable row level security;
alter table rename_codes  enable row level security;

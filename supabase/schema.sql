-- Wick leaderboard schema.
--
-- Every column exists because something reads it. What is *absent* is as
-- deliberate as what is here, so the notable omissions are called out inline
-- rather than left for someone to helpfully add later.
--
-- **This schema holds real email addresses.** That is a deliberate decision by
-- the project owner, taken so that one Claude account is one public profile
-- across every browser it signs into, with nothing for the user to do. Two
-- consequences follow and neither is hidden:
--
--   * The board is no longer anonymous to its operator. Anyone with database
--     access can read which email holds which public name. PRIVACY.md says so.
--   * **The email is not a secret and nothing verifies it.** The extension
--     reads it from claude.ai's own sidebar; it cannot prove the account is the
--     caller's, and there is no Claude API to check against. So possession of
--     an email is enough to claim its profile. The board is self-reported fun,
--     and its threat model is now "somebody could forge your entry", not
--     "somebody could not".
--
-- Apply with: supabase db push, or paste into the SQL editor.

-- ---------------------------------------------------------------------------
-- Profiles: one per Claude account.
-- ---------------------------------------------------------------------------

create table if not exists profiles (
  -- The Claude account, as read from claude.ai's user menu. **The primary key**,
  -- which is what makes one account one profile no matter how many browsers it
  -- signs into — the mapping needs no link step and no user action.
  --
  -- Lowercased by the server before it ever reaches here. Two spellings of one
  -- address must not become two profiles.
  email        text primary key,
  name         text not null,
  -- The confusable-folded form. Uniqueness is decided on this, never on `name`,
  -- or `ash`, `Ash`, `a5h` and `as-h` become four rows that read as one person.
  --
  -- Load-bearing beyond display: enrolment inserts a proposed name and lets
  -- this constraint reject the collision, rather than reading first and then
  -- writing. Drop the uniqueness and two concurrent joins can take one name.
  name_folded  text not null unique,
  created_on   date not null default current_date
);

-- ---------------------------------------------------------------------------
-- Tokens: one per browser, all pointing at one profile.
-- ---------------------------------------------------------------------------

create table if not exists tokens (
  -- sha256 of the bearer token. The plaintext is returned to the browser that
  -- enrolled and never stored, so a stolen database yields no working
  -- credential.
  --
  -- **This is not a security boundary.** Enrolment hands a fresh token to
  -- anyone who presents the email, which is the price of automatic
  -- cross-browser sync. What it does buy is that the email travels once, at
  -- enrolment, instead of on every daily submission — so it does not accumulate
  -- in the host's request logs.
  token_hash  text primary key,
  email       text not null references profiles (email) on delete cascade,
  created_on  date not null default current_date
);

create index if not exists tokens_email_idx on tokens (email);

-- ---------------------------------------------------------------------------
-- Daily rows: the leaderboard's only usage data.
-- ---------------------------------------------------------------------------

create table if not exists daily_rows (
  email     text not null references profiles (email) on delete cascade,
  -- A local calendar day as the extension saw it. Not converted, because the
  -- server never learns the submitter's timezone and has nothing to convert
  -- with.
  day       date not null,
  -- Messages sent that day. **This is the only usage figure the board holds.**
  -- Not percentages, which do not compare across plans; not tokens, which the
  -- extension cannot count and is forbidden from estimating; and not times of
  -- day, which it records locally and never sends.
  messages  integer not null check (messages >= 0),

  -- The composite key is load-bearing twice over. A resubmission *replaces* the
  -- day rather than adding to it, so a retried request corrects a total instead
  -- of inflating it — and two browsers signed into the same account submitting
  -- the same day converge on one row instead of double-counting it.
  primary key (email, day)
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
-- bypass RLS.
--
-- It matters more than it used to. These tables hold email addresses, so a
-- leaked anon key would expose the account behind every public name rather than
-- a set of hashes. Defence in depth, and the depth is now doing real work.

alter table profiles    enable row level security;
alter table tokens      enable row level security;
alter table daily_rows  enable row level security;

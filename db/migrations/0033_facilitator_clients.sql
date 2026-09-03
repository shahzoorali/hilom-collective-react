-- The client, as something a facilitator can actually see.
--
-- Every booking has been an island. A facilitator opening their calendar and
-- seeing a returning client has no "we have had four sessions, here is what we
-- covered, here is what I noticed" — the only writing attached to a session is
-- `client_notes`, one free-text box the *client* filled in at booking time.
-- There has been nowhere for the facilitator to write anything at all.
--
-- For a practice built on continuity — coaching, therapy-adjacent work, a
-- structured programme — that is not a missing convenience. It is the record
-- of the work.
--
-- ---------------------------------------------------------------------------
-- Two kinds of writing, deliberately separate
-- ---------------------------------------------------------------------------
--  * `facilitator_clients.about` — the standing picture of a person. What they
--    are working on, what to remember, how to start. Read before every session.
--  * `bookings.session_notes` — what happened in one session. Written after,
--    and belongs to that session forever.
--
-- Collapsing them into one field was tempting and wrong: the standing picture
-- is edited constantly and the session record must not be, and a single box
-- would make every update to the former an edit to the history of the latter.
--
-- ---------------------------------------------------------------------------
-- Identity, and why this is not a users table
-- ---------------------------------------------------------------------------
-- A client is still just an email, exactly as they are on `bookings` and on
-- `orders`. This table does not create a client entity; it hangs one
-- facilitator's private notes off an address, and two facilitators seeing the
-- same person keep entirely separate records — which is also the only correct
-- reading of what these notes are.
--
-- Email is matched case-insensitively, as everywhere else in the schema.
create table if not exists public.facilitator_clients (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,
  client_email   text not null,
  -- What the facilitator maintains about this person. Never shown to the
  -- client, and never leaves the handlers that scope by the caller's own
  -- facilitator row.
  about          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists facilitator_clients_unique_idx
  on public.facilitator_clients (facilitator_id, lower(client_email));

drop trigger if exists facilitator_clients_set_updated_at on public.facilitator_clients;
create trigger facilitator_clients_set_updated_at
  before update on public.facilitator_clients
  for each row execute function public.set_updated_at();

-- Per-session notes, written by the facilitator after the fact.
--
-- On `bookings` rather than in a table of their own because a session note has
-- exactly one session and no life without it: deleting the booking should take
-- the note with it, and there is never a second note for the same hour.
--
-- Distinct from `facilitator_note` (0031), which records how a manually
-- entered booking was arranged — "paid by bank transfer, 12 Sept". That is
-- bookkeeping about the transaction; this is the record of the work.
alter table public.bookings
  add column if not exists session_notes text;

-- The client timeline: every session this facilitator has had with one address.
create index if not exists bookings_facilitator_client_idx
  on public.bookings (facilitator_id, lower(client_email), starts_at desc);

-- ---------------------------------------------------------------------------
-- Disclosure
-- ---------------------------------------------------------------------------
-- These notes can describe someone's health, their history and a
-- practitioner's clinical impressions of them. RLS is enabled and grants
-- nothing: there is no anon or authenticated policy on this table at all, so
-- the only path to a row is the backend's service key inside a handler that
-- has already matched the caller's own facilitator id. `bookings.session_notes`
-- inherits the same position — `bookings` has never been client-readable — and
-- the client-facing booking handlers must not add it to their column lists.
alter table public.facilitator_clients enable row level security;

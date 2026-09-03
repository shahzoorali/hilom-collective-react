-- A place for the two people in a booking to talk.
--
-- Until now the only channel between a client and their facilitator was the
-- email addresses that appear in notification emails. There was no way to say
-- "running five minutes late", "could we move to Thursday", or "here is the
-- thing I mentioned" without one of them mailing the other's personal address
-- directly — which means every 1:1 on the platform begins by both parties
-- handing over a contact they did not choose to share, and continues entirely
-- outside anything Hilom can see, support, or moderate.
--
-- For a wellness marketplace that is not a gap in convenience. It is the
-- relationship leaving the platform on day one.
--
-- ---------------------------------------------------------------------------
-- Scoped to a booking, not to a pair of people
-- ---------------------------------------------------------------------------
-- A thread belongs to one session. That is a real constraint and it is chosen:
--  * Authorization becomes the authorization that already exists. "Can you read
--    this thread" is "is this your booking", which every handler here already
--    answers, rather than a new notion of who may contact whom.
--  * It cannot be used to reach someone you have no booking with, which is the
--    failure mode that turns a marketplace inbox into a harassment vector.
--  * The context is never ambiguous — "can we move it?" means *this* session.
--
-- The cost is that a returning client's conversation is split across sessions.
-- That is the right trade for now: the facilitator's client view (0033) already
-- gathers a person's sessions in one place, and a general inbox can be built on
-- top of these rows later without moving them.
create table if not exists public.booking_messages (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,

  -- Which side wrote it. Not derived from the email at read time: a facilitator
  -- who books a session with another facilitator, or a client whose address
  -- matches the facilitator's, would otherwise render on the wrong side of the
  -- conversation.
  sender     text not null check (sender in ('client', 'facilitator')),
  -- The verified address of whoever wrote it, for the audit trail. Display
  -- names come from the booking and the facilitator row, not from here.
  sender_email text not null,

  body       text not null check (length(btrim(body)) > 0 and length(body) <= 5000),

  -- When the *other* party opened the thread past this message. Null means
  -- unread, which is what the unread badge counts. Set in bulk when a thread is
  -- opened rather than per-message, so it is a timestamp on each row rather
  -- than a separate receipts table.
  read_at    timestamptz,

  created_at timestamptz not null default now()
);

-- The thread read: one booking's messages in order.
create index if not exists booking_messages_thread_idx
  on public.booking_messages (booking_id, created_at);

-- The unread badge, and the inbox ordering.
create index if not exists booking_messages_unread_idx
  on public.booking_messages (booking_id, sender)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- Disclosure
-- ---------------------------------------------------------------------------
-- Messages between a client and a wellness practitioner can be as sensitive as
-- the intake answers in 0032, and more candid. RLS is enabled and grants
-- nothing: like `bookings` and `facilitator_clients`, the only path to a row is
-- the backend's service key inside a handler that has already established the
-- caller is one of the two parties to that booking.
alter table public.booking_messages enable row level security;

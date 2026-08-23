-- Session reminders.
--
-- A session booked three weeks out got one email at purchase and nothing
-- since, which is the single biggest avoidable cause of a no-show — and a
-- no-show still bills the client and still pays the facilitator, so nobody
-- involved is happy about it.
--
-- One column rather than a `booking_reminders` table: there is exactly one
-- reminder per booking, so a row per send would be a table that never has more
-- than one child and still needs joining. If a second tier is ever added (an
-- hour before, say), that is the point to promote this to a table — not
-- before.
--
-- The column doubles as the idempotency key. The sweep claims a booking by
-- stamping this and only then sends, so two overlapping invocations cannot
-- both email the same person.

alter table public.bookings
  add column if not exists reminder_sent_at timestamptz;

comment on column public.bookings.reminder_sent_at is
  'When the pre-session reminder was sent. Claimed by the booking sweep before sending, so it also serves as the guard against double-sending.';

-- The sweep's query: confirmed sessions coming up that nobody has been
-- reminded about. Partial, because the rows that already have a reminder are
-- the overwhelming majority over time and are of no interest to it.
create index if not exists bookings_reminder_due_idx
  on public.bookings (starts_at)
  where status = 'confirmed' and reminder_sent_at is null;

-- Facilitator-entered packages (Canny: "Facilitator Dashboard – Manual Booking
-- Issue: Multi-Session Package Scheduling").
--
-- A facilitator booking a client into a package by hand creates a
-- booking_packages row exactly like a paid one, so credits, "scheduled vs
-- remaining", and the client's own "schedule my next session" all work
-- unchanged. The money follows 0031: nothing passed through Hilom, so price,
-- fee and net are zero and the package never enters payouts. What the client
-- paid the facilitator directly is a note for their own records.

alter table public.booking_packages
  add column if not exists booked_by text not null default 'client'
    check (booked_by in ('client', 'facilitator')),
  add column if not exists off_platform_centavos int check (off_platform_centavos >= 0),
  add column if not exists facilitator_note text;

-- A paid package can't be free (the service editor forbids a zero price), but
-- a facilitator-entered one is zero by design. Nothing enforced the former in
-- the table, so there is no check to relax.

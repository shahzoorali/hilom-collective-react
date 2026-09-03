-- Let a facilitator propose a new time instead of cancelling.
--
-- A facilitator who needs to move a session had exactly one option: cancel.
-- That refunds the client in full (a facilitator cancellation always does, and
-- should — see refundForCancellation), releases the slot, and leaves the
-- rebooking to a client who now has to go and find another time. The
-- facilitator loses the payment, the hour and often the client, for what is
-- usually "something came up, can we do Thursday?".
--
-- Modelled as a *proposal* rather than a facilitator-side reschedule. The
-- client's side of a booking is a commitment they arranged their day around;
-- moving it unilaterally is a different act from moving one's own calendar,
-- and a platform that lets one party do it to the other is one clients stop
-- trusting. So the facilitator names a time and the client says yes.
--
-- The proposed slot is deliberately **not held**. Holding it would take a real
-- bookable hour out of the calendar on the strength of an offer that may never
-- be answered, and the failure it protects against — someone else booking that
-- time first — is both rare and cleanly recoverable: acceptance re-verifies
-- the slot through the same engine as any other booking, and a lost race comes
-- back as "that time was just taken, ask for another".
--
-- One live proposal per booking. A facilitator who changes their mind
-- overwrites their own offer, which is what re-proposing means; a queue of
-- competing times for one session is a conversation, and that belongs in
-- messaging rather than in this column.
alter table public.bookings
  add column if not exists proposed_starts_at timestamptz;

-- When it was made, so the client's screen can say "proposed yesterday" and a
-- sweep could one day expire stale offers. Null exactly when
-- proposed_starts_at is null; the pair is written and cleared together.
alter table public.bookings
  add column if not exists proposed_at timestamptz;

-- The facilitator's reason, shown to the client with the offer. Optional, but
-- it is the difference between "your session moved" and "I'm so sorry, I have
-- a clinic that morning — would Thursday work?".
alter table public.bookings
  add column if not exists proposed_note text;

do $$ begin
  alter table public.bookings
    add constraint bookings_proposal_complete
      check ((proposed_starts_at is null) = (proposed_at is null));
exception when duplicate_object then null;
end $$;

-- The client's "do I have anything waiting on me?" query, and the facilitator's
-- "what have I offered that hasn't been answered?".
create index if not exists bookings_open_proposals_idx
  on public.bookings (client_email, proposed_at)
  where proposed_starts_at is not null;

-- No RLS change: `bookings` is backend-only.

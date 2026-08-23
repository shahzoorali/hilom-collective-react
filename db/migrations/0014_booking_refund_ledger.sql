-- A ledger for refunds, so "we owe this" and "we sent this" stop being the
-- same fact.
--
-- Cancelling already records `refund_centavos` — what the policy says the
-- client is owed. Nothing recorded whether that money was ever actually sent,
-- so the only way to answer "has this person been refunded?" was to go through
-- the PayMongo dashboard by hand, per booking.
--
-- Note the asymmetry this closes. Payouts — money leaving Hilom to a
-- facilitator — already had a full ledger: draft -> approved -> paid, with a
-- bank reference on the paid row (0013_payouts_reviews.sql). Refunds are money
-- leaving Hilom to a client, and had none of it. Same class of movement, same
-- need to be auditable.
--
-- Deliberately NOT a status enum. A refund has exactly two states and the
-- second is derivable: `refund_centavos > 0 and refunded_at is null` is owed,
-- `refunded_at is not null` is sent. A three-state workflow like the payout's
-- would be inventing an approval step nobody performs.
--
-- Deliberately NOT reusing the existing `refunded` value of `booking_status`
-- either. Status currently records *who* cancelled — cancelled_by_client vs
-- cancelled_by_facilitator — and overwriting that with 'refunded' would trade
-- an attribution support actually needs for a fact these two columns already
-- carry. The enum value stays unused rather than being made lossy.

alter table public.bookings
  add column if not exists refunded_at       timestamptz,
  add column if not exists refund_reference  text;

comment on column public.bookings.refund_centavos is
  'What the cancellation policy says the client is owed. Recorded on cancel; does not mean money moved.';
comment on column public.bookings.refunded_at is
  'When the refund was actually sent. Null while it is owed but unpaid.';
comment on column public.bookings.refund_reference is
  'PayMongo refund id or bank reference for the sent refund — the proof the money moved.';

-- The admin queue: "what do we still owe?", oldest first, since a refund
-- someone has been waiting on longest is the one to action next.
create index if not exists bookings_refund_due_idx
  on public.bookings (cancelled_at)
  where refund_centavos > 0 and refunded_at is null;

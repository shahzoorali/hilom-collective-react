-- Let a facilitator book a client in directly.
--
-- Everything had to go through the public paid flow, which does not cover
-- several ordinary cases: someone who paid by bank transfer or in cash, a
-- pro-bono session, a goodwill rebooking after a cancellation, a long-standing
-- client who has always just texted to arrange the next one.
--
-- ---------------------------------------------------------------------------
-- The money decision, which is the whole of the design here
-- ---------------------------------------------------------------------------
-- A session arranged and paid for off-platform must not enter the payout
-- pipeline. Payout batches exist to disburse money Hilom actually collected;
-- a booking whose price says ₱2,000 when PayMongo never saw a centavo would
-- have Hilom paying the facilitator ₱1,700 out of its own pocket, and the
-- discrepancy would only surface at reconciliation, as a shortfall nobody
-- could account for.
--
-- So a facilitator-created booking is recorded with `price_centavos`,
-- `platform_fee_centavos` and `facilitator_net_centavos` all zero — the exact
-- truth about what Hilom holds and owes — and what the client actually paid
-- the facilitator, if anything, is recorded separately in
-- `off_platform_centavos`. That column is a *note*, never an amount owed: it
-- is reported back to the facilitator so their own numbers add up, and it is
-- read by nothing that moves money.
--
-- The alternative — a payable flag on the booking — was rejected because it
-- makes every earnings and payout query responsible for remembering it, and a
-- query that forgets pays out real money. Zero is not something a sum can get
-- wrong.

-- Who created the row. 'client' for everything that came through the public
-- flow, including every row that predates this migration.
alter table public.bookings
  add column if not exists booked_by text not null default 'client'
    check (booked_by in ('client', 'facilitator'));

-- What the client paid the facilitator outside Hilom, in centavos, as reported
-- by the facilitator. Null means "not recorded" and 0 means "nothing was
-- charged" — a pro-bono session and an unrecorded arrangement are different
-- facts and the difference is worth keeping.
alter table public.bookings
  add column if not exists off_platform_centavos int
    check (off_platform_centavos is null or off_platform_centavos >= 0);

-- The facilitator's own note about the arrangement ("paid by bank transfer,
-- 12 Sept"). Distinct from `client_notes`, which is what the *client* wrote at
-- booking time and which a facilitator-created booking has none of.
alter table public.bookings
  add column if not exists facilitator_note text;

-- "Which of these did I arrange myself?" — the earnings screen separates them,
-- since their contribution to a payout is deliberately nil.
create index if not exists bookings_booked_by_idx
  on public.bookings (facilitator_id, booked_by)
  where booked_by = 'facilitator';

-- No RLS change: `bookings` is backend-only.

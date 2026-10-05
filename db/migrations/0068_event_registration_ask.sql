-- A facilitator's registration "ask" on a proposed event.
--
-- Until now a single proposed event carried no word about money: capacity,
-- ticketing and price are the admin's to set (see DRAFT_FIELDS in
-- facilitator-portal.ts), so an admin approving a proposal opened a blank
-- Registration & payment section and had to ask the facilitator by email what
-- they had in mind. Series already solve this with `proposed_price_centavos` /
-- `proposed_capacity` (0055). This gives single events the same thing.
--
-- These columns are an *ask*, never a plan. Nothing here turns ticketing on,
-- sets a capacity or creates a payment plan; the admin reads them while
-- reviewing and the ticketing editor pre-fills from them. That keeps the line
-- 0048 drew: money is the admin's decision, the facilitator only informs it.
--
-- `proposed_registration`:
--   listing - no registration through Hilom. The facilitator's external URL and
--             button label go in the existing `link_url` / `link_label`.
--   hilom   - register and pay through Hilom, using the ask below.
-- A free-registration mode is deliberately absent: payment plans require a
-- positive amount, so a free seat needs its own fulfilment path first.
alter table public.events
  add column if not exists proposed_registration text
    check (proposed_registration in ('listing', 'hilom')),
  add column if not exists proposed_price_centavos int
    check (proposed_price_centavos > 0),
  add column if not exists proposed_capacity int
    check (proposed_capacity > 0),
  -- A Manila calendar day, like the admin editor's close-date field.
  add column if not exists proposed_registration_closes_on date;

comment on column public.events.proposed_registration is
  'What the facilitator asked for: listing (external link) or hilom (register and pay here). An ask, not a plan - see 0068.';

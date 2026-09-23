-- Reclaiming money already paid out (0054, trust & safety).
--
-- ===========================================================================
-- The gap this closes
-- ===========================================================================
-- A booking, class seat or event ticket can be refunded *after* the batch
-- that paid the facilitator for it has already been marked `paid` — a
-- cancellation-window exception, a chargeback, a dispute settled weeks later.
-- Nothing catches that today: `buildPayout` only ever reads unpaid work
-- (`payout_id is null`), so a row already stamped into a paid batch is
-- invisible to every future batch. Hilom refunds the client and eats the
-- facilitator's share as well, permanently, with no record that it happened.
--
-- ===========================================================================
-- Why a second "claimed by" column, not reusing payout_id
-- ===========================================================================
-- `payout_id` is the batch that *paid* a row, and every reader of it —
-- the payout statement, the audit trail, a facilitator asking "what was in
-- batch #42" — depends on that meaning staying fixed. Overwriting it to point
-- at the clawback batch would rewrite history: the statement for the original
-- batch would lose the line it was actually paid for.
--
-- So a clawback is claimed the same way the original earning was — a second
-- column, released the same way voiding a batch already releases `payout_id`
-- — and `payout_id` never moves again once set.
alter table public.bookings
  add column if not exists clawed_back_payout_id uuid
    references public.facilitator_payouts(id) on delete set null;
alter table public.class_registrations
  add column if not exists clawed_back_payout_id uuid
    references public.facilitator_payouts(id) on delete set null;
alter table public.registration_charges
  add column if not exists clawed_back_payout_id uuid
    references public.facilitator_payouts(id) on delete set null;

comment on column public.bookings.clawed_back_payout_id is
  'The payout batch that took this booking''s net back out of a facilitator''s '
  'hands, because it was refunded after facilitator_payouts.payout_id (a '
  'different, earlier batch) already paid for it. Null means either never paid '
  'out, never refunded, or refunded but not yet reconciled.';
comment on column public.class_registrations.clawed_back_payout_id is
  'See bookings.clawed_back_payout_id — identical meaning, for a class seat.';
comment on column public.registration_charges.clawed_back_payout_id is
  'See bookings.clawed_back_payout_id — identical meaning, for an event ticket '
  'charge. The refund flag it watches is on the charge''s registration '
  '(event_registrations.refunded_at), not on the charge itself.';

-- The scan `buildPayout` runs for this facilitator: paid out, since refunded,
-- not yet clawed back. Partial on the same "unpaid work is the interesting
-- set, and it stays small" reasoning 0051 and 0054 give their own indexes.
create index if not exists bookings_clawback_idx
  on public.bookings (facilitator_id)
  where payout_id is not null and refund_centavos > 0 and refunded_at is not null
    and clawed_back_payout_id is null;
create index if not exists class_registrations_clawback_idx
  on public.class_registrations (facilitator_id)
  where payout_id is not null and refund_centavos > 0 and refunded_at is not null
    and clawed_back_payout_id is null;
create index if not exists registration_charges_clawback_idx
  on public.registration_charges (event_id)
  where payout_id is not null and facilitator_net_centavos is not null
    and clawed_back_payout_id is null;

-- ---------------------------------------------------------------------------
-- The line on the batch
-- ---------------------------------------------------------------------------
-- A batch that clawed something back needs to say so on its own statement —
-- "net 8,000" with no explanation, three months after the fact, is the kind
-- of number that generates a support thread. Stored, not derived, for the
-- same reason every other total on this table is denormalized at batch time
-- (0013): a later refund must not make a historical statement drift.
alter table public.facilitator_payouts
  add column if not exists clawback_centavos int not null default 0
    check (clawback_centavos >= 0);

comment on column public.facilitator_payouts.clawback_centavos is
  'What this batch took back for work refunded after an earlier batch had '
  'already paid it out. Subtracted from net: net_centavos = gross - '
  'platform_fee - processing - clawback. Zero on every batch that reclaimed '
  'nothing, which is most of them.';

-- Pay facilitators for the group classes they teach, and give the refunds a
-- queue to sit in.
--
-- ===========================================================================
-- The gap this closes
-- ===========================================================================
-- 0049 gave `class_registrations` the same money columns as `bookings` —
-- `price_centavos`, `platform_fee_centavos`, `facilitator_net_centavos` — and
-- a comment claiming this would "feed the existing facilitator_payouts ledger
-- with no new payout code path". That was aspiration, not fact. Nothing read
-- those columns:
--
--   * a payout batch attaches work by stamping `bookings.payout_id`, and
--     `class_registrations` had no such column;
--   * `buildPayout` selects from `bookings` and nothing else;
--   * the facilitator's earnings screen does the same.
--
-- So a facilitator could sell a class, Hilom would collect the money, the fee
-- split would be recorded correctly — and no payout batch would ever include
-- it. Shipped as-is, that is money taken and not passed on, discoverable only
-- when somebody totals it by hand.
--
-- ===========================================================================
-- Why the same columns rather than a shared line-item table
-- ===========================================================================
-- The tidier design is one `payout_items` table that both bookings and class
-- registrations point at. It was rejected for this change: it means migrating
-- every existing booking's payout linkage, and rewriting the batch builder's
-- concurrency handling — the stamp-then-read-back dance in `buildPayout` that
-- stops two simultaneous batches paying for the same session twice — against a
-- table shape nothing has exercised yet.
--
-- Mirroring the columns keeps that hard-won logic literally the same shape for
-- both sources, at the cost of the builder reading two tables instead of one.
-- A shared line-item table is the right refactor the day a third earning kind
-- appears; it is the wrong thing to attempt in the change that is fixing
-- unpaid money.
alter table public.class_registrations
  -- ON DELETE SET NULL, matching bookings (0013:76): voiding or deleting a
  -- payout must release its work back into the unpaid pool rather than
  -- cascading away the record that someone attended and paid.
  add column if not exists payout_id uuid
    references public.facilitator_payouts(id) on delete set null;

comment on column public.class_registrations.payout_id is
  'The payout batch that paid for this seat. Null means unpaid and eligible '
  'for the next batch. Set by buildPayout, cleared when a payout is voided.';

-- ---------------------------------------------------------------------------
-- The refund ledger
-- ---------------------------------------------------------------------------
-- Same two-column shape as 0014 gave bookings, and for the same reason: the
-- state is derivable rather than stored. `refund_centavos > 0 and refunded_at
-- is null` is owed; `refunded_at is not null` is sent. There is no third state
-- to get out of step.
--
-- 0049 already added `refund_centavos` and `cancelled_at`. What was missing is
-- any way to record that a refund has actually been *paid* — so the help
-- centre now promises clients a refund "within a few working days" while no
-- screen anywhere could tell an admin which refunds were outstanding, or stop
-- two admins paying the same one twice.
alter table public.class_registrations
  add column if not exists refunded_at      timestamptz,
  add column if not exists refund_reference text;

comment on column public.class_registrations.refunded_at is
  'When Hilom actually sent the refund. Null with refund_centavos > 0 means '
  'owed and outstanding — that pair is the admin refund queue.';
comment on column public.class_registrations.refund_reference is
  'The bank or PayMongo reference for the refund, recorded by the admin who sent it.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The batch builder's read: this facilitator's delivered, unpaid seats.
-- Partial on `payout_id is null` because a paid seat is never looked at again
-- by this query, and the unpaid set stays small however large the table grows.
create index if not exists class_registrations_unpaid_idx
  on public.class_registrations (facilitator_id, status)
  where payout_id is null;

-- Releasing work when a payout is voided.
create index if not exists class_registrations_payout_idx
  on public.class_registrations (payout_id)
  where payout_id is not null;

-- The admin refund queue, which is the whole of what this index is for.
create index if not exists class_registrations_refund_due_idx
  on public.class_registrations (cancelled_at)
  where refund_centavos > 0 and refunded_at is null;

-- Pay facilitators for the events they host.
--
-- ===========================================================================
-- The gap this closes
-- ===========================================================================
-- 0045 gave events a `facilitator_id` — a real host, not the display-only
-- speaker list of 0018 — and 0048 let facilitators propose events outright.
-- Neither gave the host a way to be paid. `events` and `registration_charges`
-- have no fee columns at all, and `buildPayout` reads `bookings` and
-- `class_registrations` only, so an event sells, Hilom collects, and the
-- facilitator's share exists nowhere: not on a row, not in a batch, not on
-- their earnings screen. A payout batch built for a facilitator whose only
-- work that month was an event totals zero, which is how this was found.
--
-- This is the third earning kind 0051 predicted, and it takes the same shape
-- deliberately: mirror the money columns, mirror the `payout_id` stamp, and
-- let the batch builder read one more table. The shared `payout_items` table
-- 0051 argued for remains the right refactor and remains the wrong thing to
-- attempt while money is going unpaid.
--
-- ===========================================================================
-- Why the split lives on the charge, not the registration
-- ===========================================================================
-- An instalment plan (0016) is N charges against one registration, paid weeks
-- apart and individually refundable or voidable. What a facilitator has earned
-- is the sum of what actually cleared, so the unit that carries a split has to
-- be the unit that carries a payment. Putting it on the registration would
-- mean either paying out a deposit as if it were the whole price, or
-- recomputing the earned portion on every read.
--
-- It also gives the batch builder the same `payout_id is null` claim it uses
-- for bookings, at the same granularity as the money.
-- ---------------------------------------------------------------------------
-- The rate
-- ---------------------------------------------------------------------------
-- Per event, set by the admin who approves it, and null by default.
--
-- Null is not "zero percent" — it means this event has no revenue share at
-- all, which is every event that exists today: they were created by admins for
-- Hilom's own programme, and the money is Hilom's. A null rate produces a null
-- split on the charge, and the batch builder ignores rows with a null split.
-- That is what keeps this migration from retroactively owing anybody for
-- events already sold.
--
-- Per event rather than per facilitator (`facilitators.platform_fee_bps`,
-- which governs sessions and classes) because an event is negotiated: a
-- facilitator's own workshop and a Hilom-produced retreat they are hosting are
-- not the same deal, and both are events.
alter table public.events
  add column if not exists platform_fee_bps int
    check (platform_fee_bps between 0 and 10000);

comment on column public.events.platform_fee_bps is
  'Hilom''s cut of this event''s ticket sales, in basis points, set by the '
  'admin who approves it. Null means no revenue share — the money is Hilom''s, '
  'which is every pre-0054 event. Copied onto each charge as it is paid.';

-- ---------------------------------------------------------------------------
-- When an event counts as delivered
-- ---------------------------------------------------------------------------
-- A payout period is judged on when the work happened, and for an event that
-- is when it ended — except `ends_at` is optional (0007), and a single-evening
-- event routinely has only a start. Every reader would otherwise repeat
-- `coalesce(ends_at, starts_at)`, and PostgREST cannot express a coalesce in a
-- filter at all, so the batch builder could not ask the question it needs to.
--
-- Stored rather than virtual so it can be indexed, which is the whole point.
alter table public.events
  add column if not exists delivered_at timestamptz
    generated always as (coalesce(ends_at, starts_at)) stored;

comment on column public.events.delivered_at is
  'When the event finished: ends_at, or starts_at when no end was set. The '
  'column payout periods are judged on. Generated — never write to it.';

-- ---------------------------------------------------------------------------
-- The split, on each charge
-- ---------------------------------------------------------------------------
-- Same three-column shape as bookings (0013) and class_registrations (0049),
-- so `sumPayable` totals all three sources with one reducer. `amount_centavos`
-- already plays the part `price_centavos` plays there.
--
-- Both are null until the charge is paid, and stay null forever on an event
-- with no rate. Nullable rather than defaulting to zero on purpose: zero is a
-- real answer (a free event, a 100% fee) and must not be confused with "this
-- was never split", which is the condition the batch builder excludes on.
alter table public.registration_charges
  add column if not exists platform_fee_centavos int
    check (platform_fee_centavos >= 0),
  add column if not exists facilitator_net_centavos int
    check (facilitator_net_centavos >= 0),
  -- ON DELETE SET NULL, matching bookings (0013) and class seats (0051):
  -- deleting or voiding a payout releases its work back into the unpaid pool
  -- rather than cascading away the record that somebody paid.
  add column if not exists payout_id uuid
    references public.facilitator_payouts(id) on delete set null;

comment on column public.registration_charges.platform_fee_centavos is
  'Hilom''s cut of this charge, computed by splitFee() from the event''s '
  'platform_fee_bps at the moment the charge was paid. Null means the event '
  'has no revenue share, and this charge is never paid out.';
comment on column public.registration_charges.facilitator_net_centavos is
  'What the host earned from this charge. Null means no revenue share. '
  'Together with platform_fee_centavos it sums back to amount_centavos.';
comment on column public.registration_charges.payout_id is
  'The payout batch that paid for this charge. Null means unpaid and eligible '
  'for the next batch. Set by buildPayout, cleared when a payout is voided.';

-- The two halves must sum back to the charge, or a batch pays a number that
-- does not reconcile against what the client was billed. splitFee guarantees
-- this by construction; the constraint is what makes a second writer — an
-- admin correction, a future import — unable to break it quietly.
alter table public.registration_charges
  drop constraint if exists registration_charges_split_sums;
alter table public.registration_charges
  add constraint registration_charges_split_sums
    check (
      (platform_fee_centavos is null and facilitator_net_centavos is null)
      or (
        platform_fee_centavos is not null
        and facilitator_net_centavos is not null
        and platform_fee_centavos + facilitator_net_centavos = amount_centavos
      )
    );

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The batch builder's read: paid, split, unclaimed charges. Partial on
-- `payout_id is null` for the reason 0051 gives — a paid-out charge is never
-- looked at by this query again, so the index stays the size of the backlog
-- rather than the size of the ledger.
create index if not exists registration_charges_unpaid_payout_idx
  on public.registration_charges (event_id, status)
  where payout_id is null and facilitator_net_centavos is not null;

-- Releasing work when a payout is voided.
create index if not exists registration_charges_payout_idx
  on public.registration_charges (payout_id)
  where payout_id is not null;

-- Resolving a facilitator's events within a period, which is the other half of
-- the batch builder's read.
create index if not exists events_host_delivered_idx
  on public.events (facilitator_id, delivered_at)
  where facilitator_id is not null;

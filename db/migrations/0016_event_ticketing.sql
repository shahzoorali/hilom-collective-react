-- Ticketed events, part 1 of 2: capacity, payment plans, registrations, and the
-- per-charge money ledger.
--
-- This extends public.events (0007_events.sql) rather than introducing a
-- parallel "ticketed event" table. 0007's own header says ticketing "is closer
-- to the products/orders schema in 0001 than to this table" — that was right
-- about the money and wrong about the identity. An event that sells 13 seats is
-- the same row the public /events list renders: same title, dates, image,
-- description and draft/published status. A second table would mean two places
-- to publish, two places to fix a venue typo, and a join on the listing page.
-- Every column added below is nullable or defaulted, so a listing-only event is
-- untouched and backend/src/handlers/events.ts keeps working unchanged.
--
-- Design decisions worth stating up front:
--
--  * **Pricing does not live on the event.** "₱30,000 early bird until 30 Sep,
--    ₱35,000 after, instalments only during early bird" is three offers with
--    three eligibility windows, not two price columns and a date. Modelling
--    them as payment *plans* makes that configuration rather than code, and
--    makes a future event with a couples rate and a six-part plan a data
--    change instead of a migration.
--
--  * **Capacity is enforced by the database, not by application code.** Same
--    principle as bookings (0012), different tool: a seat count is not a time
--    overlap, so a GiST exclusion constraint does not apply. See the long note
--    above claim_event_seat() for what is used instead and why.
--
--  * **The charge schedule is materialized at signup, not read through to the
--    plan.** The plan is editable; a schedule someone agreed to is not. If an
--    admin moves the November due date next week, people who registered last
--    week keep the dates they signed up for and only new registrations get the
--    new ones. Same reasoning as the payout ledger in 0013:34-36 — recomputing
--    on read would let a historical charge drift, which is precisely what a
--    ledger must not do.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- residential — multi-day, someone sleeps there; the roster needs dietary
--               requirements, an emergency contact and a room preference
-- virtual     — online; the roster needs a join link and a timezone instead
-- day         — in person, single day
do $$ begin
  create type public.event_format as enum ('residential', 'virtual', 'day');
exception when duplicate_object then null;
end $$;

-- full        — one charge, payable immediately
-- installment — N charges on a schedule
do $$ begin
  create type public.payment_plan_kind as enum ('full', 'installment');
exception when duplicate_object then null;
end $$;

-- pending_payment — seat held, deposit not yet cleared. Expires.
-- confirmed       — deposit cleared. The seat is theirs, and nothing but an
--                   admin decision takes it back — including a missed
--                   instalment. That is a product rule, not an oversight:
--                   overdue payments are flagged for a human, never swept.
-- expired         — the hold lapsed unpaid. Kept rather than deleted, unlike
--                   bookings: the registrant typed in their dietary needs and
--                   emergency contact, and "they tried and the QR timed out" is
--                   a sales lead, not noise.
-- cancelled       — an admin cancelled, or approved a cancellation request.
-- completed       — the event has ended.
do $$ begin
  create type public.registration_status as enum (
    'pending_payment',
    'confirmed',
    'expired',
    'cancelled',
    'completed'
  );
exception when duplicate_object then null;
end $$;

-- scheduled        — a future instalment; no payment attempt yet
-- awaiting_payment — a checkout session is open for it right now
-- paid             — cleared, online or marked offline by an admin
-- waived           — an admin forgave it. Settled, but not money — which is why
--                    it is a distinct value and not just 'paid'.
-- void             — superseded, e.g. the registrant paid their balance early
--                    and the remaining scheduled charges no longer apply
-- refunded         — money was returned against this charge
do $$ begin
  create type public.charge_status as enum (
    'scheduled',
    'awaiting_payment',
    'paid',
    'waived',
    'void',
    'refunded'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- events: the ticketing columns
-- ---------------------------------------------------------------------------
alter table public.events
  add column if not exists ticketing_enabled      boolean not null default false,
  add column if not exists format                 public.event_format,
  -- Null is not "unlimited". An event with ticketing on and no capacity is
  -- rejected by the admin validator, because an unbounded retreat is always a
  -- data-entry mistake and never an intention.
  add column if not exists capacity               int check (capacity is null or capacity > 0),
  add column if not exists currency               text not null default 'PHP',
  add column if not exists registration_opens_at  timestamptz,
  -- No default, deliberately. Close dates are per-event and admin-set;
  -- inventing "starts_at minus seven days" here would silently close
  -- registration on an event whose organiser never chose that.
  add column if not exists registration_closes_at timestamptz,
  -- How long an unpaid registration holds its seat. Sixty minutes by default: a
  -- QRPh payment takes minutes, and one seat out of thirteen is expensive to
  -- leave parked.
  add column if not exists hold_minutes           int not null default 60
    check (hold_minutes between 5 and 1440),
  add column if not exists venue_details          text,
  -- Sanitized HTML, same treatment as events.description
  -- (backend/src/lib/sanitize.ts) — allowlisted on write, trusted on render.
  add column if not exists terms_html             text,
  -- Which registrant fields this event actually asks for, so a virtual event
  -- does not demand an emergency contact and a residential one does. An array
  -- of field keys validated against a whitelist in
  -- backend/src/lib/event-ticketing.ts. JSONB rather than columns because the
  -- set is per-event by definition.
  add column if not exists registrant_fields      jsonb not null default '[]'::jsonb;

comment on column public.events.ticketing_enabled is
  'False for a listing-only event: the entire registration surface is off and the row behaves exactly as it did before 0016.';

comment on column public.events.capacity is
  'Total seats. Enforced by claim_event_seat() under a row lock, backstopped by event_registrations_seat_idx.';

-- The public "can I still register?" read and the sweep's event scan.
create index if not exists events_ticketing_idx
  on public.events (status, registration_closes_at)
  where ticketing_enabled;

-- ---------------------------------------------------------------------------
-- Payment plans
-- ---------------------------------------------------------------------------
-- One row per offer. The Return to Self retreat has three:
--
--   Early bird — pay in full   full         3 000 000   until 2026-09-30
--   Early bird — 4 payments    installment  3 000 000   until 2026-09-30
--   Full payment               full         3 500 000   from  2026-10-01
--
-- available_until is the eligibility cutoff. Note that it is checked twice: at
-- seat claim, and again when the deposit clears — because the rule is that the
-- instalment plan is available if the down payment *clears* by 30 September,
-- and a QRPh payment begun at 23:52 can clear at 00:03. See
-- backend/src/lib/registration-fulfillment.ts; a deposit that clears late is
-- honoured and flagged for an admin, never silently voided.
create table if not exists public.event_payment_plans (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  name            text not null,
  description     text,
  kind            public.payment_plan_kind not null,

  -- What the whole event costs under this plan. For an instalment plan the
  -- child rows must sum to exactly this, enforced by the trigger below —
  -- ₱5,000 + ₱8,333.35 × 3 is precisely the arithmetic a human gets wrong, and
  -- precisely the error nobody notices until the final payment is five
  -- centavos out.
  total_centavos  int not null check (total_centavos >= 0),
  currency        text not null default 'PHP',

  available_from  timestamptz,
  available_until timestamptz,
  is_active       boolean not null default true,
  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists event_payment_plans_event_idx
  on public.event_payment_plans (event_id, sort_order);

drop trigger if exists event_payment_plans_set_updated_at on public.event_payment_plans;
create trigger event_payment_plans_set_updated_at
  before update on public.event_payment_plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The schedule template
-- ---------------------------------------------------------------------------
-- One row per instalment. `due_at` (an absolute instant) and `due_offset_days`
-- (relative to the registration) are mutually exclusive: a retreat with fixed
-- 31 Oct / 30 Nov / 30 Dec dates needs the first, and an evergreen online
-- programme selling all year round needs the second. Supporting only absolute
-- dates would make the second a migration later.
--
-- Absolute dates are always entered by the admin as an Asia/Manila end of day —
-- 2026-10-31T23:59:59+08 — so that "due 31 October" means what a Filipino
-- registrant thinks it means. That conversion happens once, in
-- backend/src/lib/event-ticketing.ts, so no reader of this table has to know
-- about it.
create table if not exists public.event_plan_installments (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.event_payment_plans(id) on delete cascade,
  seq             int not null check (seq > 0),
  label           text not null,
  amount_centavos int not null check (amount_centavos > 0),

  due_at          timestamptz,
  due_offset_days int check (due_offset_days >= 0),

  -- The first charge: the one whose clearing confirms the seat and decides plan
  -- eligibility. Exactly one per plan, enforced by the trigger below. Its
  -- due_at is null in the template and resolved at materialization to
  -- now + hold_minutes, because a deposit is due now by definition and a fixed
  -- template date for it would be wrong for every registration but the first.
  is_deposit      boolean not null default false,

  created_at      timestamptz not null default now(),

  constraint event_plan_installments_due_one_of
    check ((due_at is null) <> (due_offset_days is null) or is_deposit)
);

create unique index if not exists event_plan_installments_seq_idx
  on public.event_plan_installments (plan_id, seq);

-- ---------------------------------------------------------------------------
-- The arithmetic guard
-- ---------------------------------------------------------------------------
-- A statement-level constraint trigger rather than a check constraint, because
-- the invariant spans rows: sum(children) = parent.total_centavos, with exactly
-- one deposit. The backend validates the same thing before writing, with a unit
-- test on the real retreat numbers — but the backend is one caller, and this
-- table will also be edited by hand during setup. A plan whose parts do not add
-- up sells a retreat at the wrong price.
--
-- DEFERRABLE INITIALLY DEFERRED is what lets an admin rewrite a whole schedule
-- inside one transaction (delete four rows, insert five) without the
-- intermediate states tripping it.
--
-- ⚠ Deferred means "at commit", and every PostgREST call is its own
-- transaction — so writing instalments one row at a time through supabase-js
-- WILL fail on the first insert. The plan-write path must be the
-- replace_event_plans() RPC in 0017, which does the whole set in one statement.
create or replace function public.check_plan_installment_totals()
returns trigger
language plpgsql
-- Empty search_path for the same reason set_updated_at() has one (0001:105-116):
-- this runs as the table owner and must not resolve names via a caller-supplied
-- search_path.
set search_path = ''
as $$
declare
  v_plan_id  uuid;
  v_total    int;
  v_sum      int;
  v_deposits int;
begin
  v_plan_id := coalesce(new.plan_id, old.plan_id);

  select total_centavos into v_total
    from public.event_payment_plans where id = v_plan_id;
  -- The plan was deleted in the same statement; the children went with it.
  if not found then return null; end if;

  select coalesce(sum(amount_centavos), 0), count(*) filter (where is_deposit)
    into v_sum, v_deposits
    from public.event_plan_installments where plan_id = v_plan_id;

  -- An empty schedule is a plan mid-edit, not a violation.
  if v_sum = 0 then return null; end if;

  if v_sum <> v_total then
    raise exception 'plan % instalments sum to % but the plan total is %',
      v_plan_id, v_sum, v_total using errcode = 'check_violation';
  end if;

  if v_deposits <> 1 then
    raise exception 'plan % must have exactly one deposit instalment, found %',
      v_plan_id, v_deposits using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- CREATE CONSTRAINT TRIGGER has no IF NOT EXISTS; drop-then-create keeps this
-- re-runnable, same as the plain triggers elsewhere.
drop trigger if exists event_plan_installments_totals on public.event_plan_installments;
create constraint trigger event_plan_installments_totals
  after insert or update or delete on public.event_plan_installments
  deferrable initially deferred
  for each row execute function public.check_plan_installment_totals();

-- ---------------------------------------------------------------------------
-- Registrations
-- ---------------------------------------------------------------------------
create table if not exists public.event_registrations (
  id       uuid primary key default gen_random_uuid(),
  -- restrict, not cascade, on both: deleting an event or a plan must not erase
  -- the record of money people paid. Same rule as bookings -> services (0012).
  event_id uuid not null references public.events(id) on delete restrict,
  plan_id  uuid not null references public.event_payment_plans(id) on delete restrict,

  -- The payer. Like orders and bookings, there is no users table: the verified
  -- Cognito email is the identity, and `sub` is kept alongside because an email
  -- can change.
  buyer_email       text not null,
  buyer_cognito_sub text,

  -- The attendee, who is not necessarily the payer — and who can be changed by
  -- the payer, since transferring a slot to a friend is asked at every retreat.
  -- Typed columns for what every event asks and what the roster sorts and
  -- exports on; JSONB for the per-event extras declared in
  -- events.registrant_fields (dietary, emergency contact, room preference,
  -- accessibility needs). Splitting it this way keeps "sort the roster by
  -- surname" a plain ORDER BY and keeps "this retreat also needs a shirt size"
  -- out of the migration queue.
  registrant_name    text not null,
  registrant_email   text not null,
  registrant_phone   text,
  registrant_details jsonb not null default '{}'::jsonb,
  -- Stamped whenever the attendee is reassigned, so the roster can show a
  -- transfer badge without diffing the audit log.
  transferred_at     timestamptz,

  status   public.registration_status not null default 'pending_payment',

  -- 1..capacity, assigned by claim_event_seat(). See the index below for why
  -- capacity is enforced through a number rather than a count.
  seat_no  int not null check (seat_no > 0),

  -- Snapshots, for the reason 0013:34-36 gives: editing the plan in November
  -- must not restate what someone agreed to in September.
  plan_name      text not null,
  plan_kind      public.payment_plan_kind not null,
  total_centavos int not null check (total_centavos >= 0),
  currency       text not null default 'PHP',

  -- Set by an admin overriding the price. The delta is reconciled by voiding
  -- and reissuing unpaid charges, never by editing a paid one.
  price_override_centavos int check (price_override_centavos >= 0),
  price_override_reason   text,

  -- Null once confirmed. While pending_payment, the instant after which the
  -- sweep — and the next claim on this event — may reclaim the seat.
  hold_expires_at timestamptz,

  -- When the deposit actually cleared. This, not created_at, is what the
  -- "instalments only if the down payment clears by 30 September" rule is
  -- judged on, which is why it is a column and not a derived read of the ledger.
  confirmed_at    timestamptz,

  -- Set by the sweep when a charge goes overdue. Deliberately NOT a status
  -- change: flagging is for an admin's attention queue, and the seat stays held.
  flagged_at  timestamptz,
  flag_reason text,

  -- Cancellation. Columns rather than a table, the same call 0014 made for the
  -- refund ledger: the states here are few and derivable.
  -- Requested (requested_at set, decided_at null) -> approved | declined.
  cancellation_requested_at timestamptz,
  cancellation_reason       text,
  cancellation_decided_at   timestamptz,
  cancellation_decision     text check (cancellation_decision in ('approved', 'declined')),
  cancelled_at              timestamptz,
  cancelled_by              text check (cancelled_by in ('registrant', 'admin')),

  -- Recorded, not executed — consistent with bookings and with the standing
  -- "manual revoke, no automation" rule. Note that the retreat product has no
  -- refund policy at all: nothing computes these, and a non-null value means an
  -- admin decided on an exception.
  refund_centavos  int check (refund_centavos >= 0),
  refunded_at      timestamptz,
  refund_reference text,

  admin_notes  text,
  error_detail text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The constraint that makes capacity real
-- ---------------------------------------------------------------------------
-- Thirteen seats and two people clicking the last one is the same defining race
-- 0012 solved with a GiST exclusion constraint — but a seat count is not an
-- overlap, so that tool does not transfer. Four options were considered:
--
--   * a counter column with a check constraint — a check cannot see other rows,
--     and every writer would have to remember to increment it;
--   * an advisory lock taken in the handler — correct, but invisible to a
--     second call site, which is the failure mode 0012's header rejects;
--   * SERIALIZABLE — supabase-js cannot set an isolation level, and in fact
--     cannot open a transaction at all;
--   * pre-created seat rows claimed by unique key.
--
-- What is used is the fourth idea without the second table: seats are numbered
-- 1..capacity on the registration itself, and this partial unique index makes a
-- number exclusive among live rows. Assignment happens inside claim_event_seat()
-- under a FOR UPDATE lock on the event row, which is what actually serialises
-- concurrent claimants; this index is the schema-level backstop that makes a
-- bug in — or a bypass of — that function fail loudly with a 23505 instead of
-- quietly selling a fourteenth seat.
--
-- Expired and cancelled rows sit outside the predicate, so a lapsed hold frees
-- its number for reuse the moment the status moves.
--
-- An index rather than a UNIQUE constraint because a constraint cannot be
-- partial, and the whole point here is the WHERE clause.
create unique index if not exists event_registrations_seat_idx
  on public.event_registrations (event_id, seat_no)
  where status in ('pending_payment', 'confirmed');

-- "My registrations", newest first.
create index if not exists event_registrations_buyer_idx
  on public.event_registrations (lower(buyer_email), created_at desc);

-- The roster, and the live-seat count inside claim_event_seat().
create index if not exists event_registrations_event_status_idx
  on public.event_registrations (event_id, status, seat_no);

-- The sweep's hold-expiry scan.
create index if not exists event_registrations_hold_idx
  on public.event_registrations (hold_expires_at)
  where status = 'pending_payment';

-- The admin attention queue: flagged first, oldest flag first.
create index if not exists event_registrations_flagged_idx
  on public.event_registrations (flagged_at)
  where flagged_at is not null and status = 'confirmed';

-- The admin cancellation queue: requested but not yet decided.
create index if not exists event_registrations_cancel_requests_idx
  on public.event_registrations (cancellation_requested_at)
  where cancellation_requested_at is not null and cancellation_decided_at is null;

drop trigger if exists event_registrations_set_updated_at on public.event_registrations;
create trigger event_registrations_set_updated_at
  before update on public.event_registrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The money ledger
-- ---------------------------------------------------------------------------
-- One row per charge, materialized from the plan's schedule at registration.
--
-- A table rather than columns — the distinction 0014 draws when it made the
-- booking refund ledger two columns instead. A refund has two states and the
-- second is derivable, so columns were right there. An instalment plan is N
-- charges each with its own due date, status, payment id, receipt number and
-- reminder history. That is the payouts case (0013), not the refunds case.
create table if not exists public.registration_charges (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations(id) on delete cascade,
  -- Denormalized so the admin money query ("what is outstanding across this
  -- event?") is one indexed scan rather than a join through registrations.
  event_id        uuid not null references public.events(id) on delete restrict,

  seq             int not null check (seq > 0),
  label           text not null,
  is_deposit      boolean not null default false,
  amount_centavos int not null check (amount_centavos > 0),
  currency        text not null default 'PHP',
  due_at          timestamptz not null,

  status          public.charge_status not null default 'scheduled',

  -- Mirrors orders.paymongo_payment_id and bookings.paymongo_payment_id, and is
  -- the same idempotency key against PayMongo's at-least-once delivery. One
  -- hosted-checkout purchase fires both payment.paid and
  -- checkout_session.payment.paid; the unique constraint is what collapses them
  -- onto one row.
  paymongo_payment_id text unique,
  paymongo_session_id text,
  -- The live hosted-checkout URL, so "resend payment link" re-sends rather than
  -- minting a second session. Two open sessions for one charge are two ways to
  -- pay it, and the second payment has nowhere to land.
  checkout_url        text,
  checkout_expires_at timestamptz,

  paid_at        timestamptz,
  -- 'paymongo' | 'bank_transfer' | 'gcash_manual' | 'cash' | 'waived'
  paid_method    text,
  paid_reference text,
  -- Assigned on the transition to paid, from receipt_no_seq. Human-facing,
  -- monotonic, and never reused: a receipt someone has already downloaded must
  -- keep its number forever.
  receipt_no     text unique,

  -- Set by the sweep when due_at passes unpaid. Distinct from the
  -- registration-level flag, which is the roll-up across charges.
  flagged_at     timestamptz,

  refund_centavos  int check (refund_centavos >= 0),
  refunded_at      timestamptz,
  refund_reference text,

  voided_at    timestamptz,
  void_reason  text,
  error_detail text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists registration_charges_seq_idx
  on public.registration_charges (registration_id, seq);

-- The sweep's reminder and overdue scans, and the buyer's "what is next".
create index if not exists registration_charges_due_idx
  on public.registration_charges (due_at)
  where status in ('scheduled', 'awaiting_payment');

-- The admin money summary for one event.
create index if not exists registration_charges_event_status_idx
  on public.registration_charges (event_id, status, due_at);

drop trigger if exists registration_charges_set_updated_at on public.registration_charges;
create trigger registration_charges_set_updated_at
  before update on public.registration_charges
  for each row execute function public.set_updated_at();

-- Receipt numbers come from a sequence rather than count(*) + 1: counting would
-- reuse a number after a deletion, and two receipts sharing a number is the one
-- thing a receipt may never do. Gaps are fine — a gap means an abandoned
-- checkout, not a missing receipt.
create sequence if not exists public.receipt_no_seq;

create or replace function public.next_receipt_no()
returns text
language sql
set search_path = ''
as $$
  select 'HR-'
      || to_char(now() at time zone 'Asia/Manila', 'YYYY')
      || '-'
      || lpad(nextval('public.receipt_no_seq')::text, 6, '0');
$$;

-- ---------------------------------------------------------------------------
-- claim_event_seat — the atomic registration
-- ---------------------------------------------------------------------------
-- supabase-js cannot open a transaction, so everything that has to happen
-- together happens here and is invoked with a single .rpc(): release this
-- event's lapsed holds, verify the registration window, verify the plan is on
-- offer, count live seats, assign the lowest free number, insert the
-- registration, and materialize the charge schedule.
--
-- `select ... for update` on the event row is what serialises claimants. It is
-- one row per event, held for microseconds, and it means the seat count read
-- below cannot change underneath us — closing the read-then-insert race that
-- 0012's header calls the defining failure of a booking system. The partial
-- unique index on (event_id, seat_no) is the second line of defence for any
-- writer that does not come through here.
--
-- Amounts are passed in rather than read from the plan inside this function, so
-- that a price override, a proration, or a plan edited between the quote the
-- browser was shown and this call cannot silently change what is charged: the
-- backend computes the schedule (event-ticketing.ts, unit-tested) and this
-- function records it. The total is still re-checked against the plan, so that
-- flexibility cannot be used to sell a ₱30,000 retreat for ₱1.
--
-- Errors are raised with stable message strings that the handler maps to HTTP
-- status codes; P0001 is the generic "business rule said no".
create or replace function public.claim_event_seat(
  p_event_id     uuid,
  p_plan_id      uuid,
  p_buyer_email  text,
  p_buyer_sub    text,
  p_registrant   jsonb,   -- {name, email, phone, details}
  p_charges      jsonb,   -- [{seq, label, is_deposit, amount_centavos, due_at}, ...]
  p_hold_minutes int
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event  public.events%rowtype;
  v_plan   public.event_payment_plans%rowtype;
  v_taken  int;
  v_seat   int;
  v_sum    int;
  v_reg_id uuid;
  v_hold   timestamptz := now() + make_interval(mins => p_hold_minutes);
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  if not v_event.ticketing_enabled or v_event.status <> 'published' then
    raise exception 'ticketing_closed' using errcode = 'P0001';
  end if;
  if v_event.capacity is null then
    raise exception 'capacity_not_configured' using errcode = 'P0001';
  end if;
  if v_event.registration_opens_at is not null and now() < v_event.registration_opens_at then
    raise exception 'registration_not_open' using errcode = 'P0001';
  end if;
  if v_event.registration_closes_at is not null and now() > v_event.registration_closes_at then
    raise exception 'registration_closed' using errcode = 'P0001';
  end if;

  select * into v_plan from public.event_payment_plans
   where id = p_plan_id and event_id = p_event_id and is_active;
  if not found then
    raise exception 'plan_not_available' using errcode = 'P0001';
  end if;
  if (v_plan.available_from is not null and now() < v_plan.available_from)
     or (v_plan.available_until is not null and now() > v_plan.available_until) then
    raise exception 'plan_not_available' using errcode = 'P0001';
  end if;

  select coalesce(sum((c->>'amount_centavos')::int), 0) into v_sum
    from jsonb_array_elements(p_charges) c;
  if v_sum <> v_plan.total_centavos then
    raise exception 'charge_total_mismatch' using errcode = 'P0001';
  end if;

  -- Lapsed holds, released inline. The seat index cannot read hold_expires_at
  -- (a partial index predicate must be immutable), so without this an abandoned
  -- checkout keeps its number until the sweep next runs — the same inline
  -- release that POST /bookings does before generating slots.
  update public.event_registrations
     set status = 'expired'
   where event_id = p_event_id
     and status = 'pending_payment'
     and hold_expires_at < now();

  select count(*) into v_taken
    from public.event_registrations
   where event_id = p_event_id
     and status in ('pending_payment', 'confirmed');

  if v_taken >= v_event.capacity then
    raise exception 'sold_out' using errcode = 'P0001';
  end if;

  -- Lowest free number, so a released seat 3 is resold as seat 3 rather than
  -- the roster growing gaps as holds come and go.
  select min(g) into v_seat
    from generate_series(1, v_event.capacity) g
   where not exists (
     select 1 from public.event_registrations r
      where r.event_id = p_event_id
        and r.seat_no = g
        and r.status in ('pending_payment', 'confirmed'));

  insert into public.event_registrations (
    event_id, plan_id, buyer_email, buyer_cognito_sub,
    registrant_name, registrant_email, registrant_phone, registrant_details,
    status, seat_no, plan_name, plan_kind, total_centavos, currency, hold_expires_at
  ) values (
    p_event_id, p_plan_id, lower(p_buyer_email), p_buyer_sub,
    p_registrant->>'name', lower(p_registrant->>'email'), p_registrant->>'phone',
    coalesce(p_registrant->'details', '{}'::jsonb),
    'pending_payment', v_seat, v_plan.name, v_plan.kind,
    v_plan.total_centavos, v_plan.currency, v_hold
  ) returning id into v_reg_id;

  insert into public.registration_charges (
    registration_id, event_id, seq, label, is_deposit,
    amount_centavos, currency, due_at, status
  )
  select v_reg_id,
         p_event_id,
         (c->>'seq')::int,
         c->>'label',
         coalesce((c->>'is_deposit')::boolean, false),
         (c->>'amount_centavos')::int,
         v_plan.currency,
         (c->>'due_at')::timestamptz,
         -- The deposit is payable now; everything else waits its turn, so that
         -- "pay the next instalment" has exactly one answer at any moment.
         case when coalesce((c->>'is_deposit')::boolean, false)
              then 'awaiting_payment'::public.charge_status
              else 'scheduled'::public.charge_status
         end
    from jsonb_array_elements(p_charges) c;

  return v_reg_id;
end;
$$;

revoke all on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int)
  from public, anon, authenticated;
grant execute on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Plans and their instalments follow the published-content shape (0007): the
-- registration page has to render prices and schedules, and a price is public
-- by nature. Both are gated on the parent event being published and ticketed.
--
-- Registrations and charges follow the backend-only shape (0012:172-175)
-- without qualification. They hold names, dietary and medical notes, emergency
-- contacts, payment ids and receipt numbers; nothing in the browser ever reads
-- them directly. Both the registrant's own view and the admin roster go through
-- Lambda, which authorizes the caller against the row before returning it.
--
-- service_role bypasses RLS but still needs explicit grants, or every backend
-- read and write fails with 42501 — see the note in 0002_rls.sql.
-- ---------------------------------------------------------------------------
alter table public.event_payment_plans enable row level security;
grant select on public.event_payment_plans to anon, authenticated;

drop policy if exists event_payment_plans_public_read on public.event_payment_plans;
create policy event_payment_plans_public_read
  on public.event_payment_plans for select
  to anon, authenticated
  using (
    is_active and exists (
      select 1 from public.events e
       where e.id = event_id
         and e.status = 'published'
         and e.ticketing_enabled));

alter table public.event_plan_installments enable row level security;
grant select on public.event_plan_installments to anon, authenticated;

drop policy if exists event_plan_installments_public_read on public.event_plan_installments;
create policy event_plan_installments_public_read
  on public.event_plan_installments for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.event_payment_plans p
        join public.events e on e.id = p.event_id
       where p.id = plan_id
         and p.is_active
         and e.status = 'published'
         and e.ticketing_enabled));

alter table public.event_registrations enable row level security;
revoke all on public.event_registrations from anon, authenticated;

alter table public.registration_charges enable row level security;
revoke all on public.registration_charges from anon, authenticated;

grant select, insert, update, delete
  on public.event_payment_plans,
     public.event_plan_installments,
     public.event_registrations,
     public.registration_charges
  to service_role;

grant usage, select on sequence public.receipt_no_seq to service_role;
grant execute on function public.next_receipt_no() to service_role;

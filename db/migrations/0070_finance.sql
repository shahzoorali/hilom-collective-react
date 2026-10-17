-- Finance: the admin section that replaces the hand-kept Sales & P&L workbook.
--
-- Sales are not re-keyed. Every sale already exists in its own transaction
-- table (orders, registration_charges, class_registrations, bookings,
-- booking_packages) together with the split the platform charged, so the sales
-- register is a view over those (v_revenue_lines) and refunds likewise
-- (v_refund_lines). What humans enter is only what the platform cannot know:
-- expenses, who paid them, manual adjustments, and revenue-share deals that are
-- not a plain percentage (Batara's flat ₱1,500 per head).
--
-- The one money fact the platform did not keep is what PayMongo actually
-- charged. payment_ledger stores it, captured from /v1/payments/{id} after the
-- webhook fires and backfilled for history. It is a snapshot of PayMongo's
-- record, refreshed by the nightly finance job until it carries a payout id,
-- after which PayMongo no longer changes it.

-- ---------------------------------------------------------------------------
-- payment_ledger — what PayMongo charged and paid out, one row per payment
-- ---------------------------------------------------------------------------
create table if not exists public.payment_ledger (
  paymongo_payment_id text primary key,
  source_table        text not null
    check (source_table in ('orders', 'registration_charges', 'class_registrations', 'bookings', 'booking_packages', 'unknown')),
  source_id           uuid,
  status              text,                -- PayMongo's payment status (paid, refunded, …)
  paid_at             timestamptz,
  gross_centavos      int not null default 0,
  fee_centavos        int,                 -- PayMongo fee incl. VAT; null until fetched
  fee_vat_centavos    int,                 -- VAT portion of fee_centavos (fee × 12/112)
  net_centavos        int,
  method              text,                -- gcash / paymaya / card / qrph / …
  payout_id           text,                -- PayMongo payout the net landed in
  payout_date         date,
  is_test             boolean not null default false,
  test_reason         text,
  raw                 jsonb,
  fetch_error         text,
  fetched_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists payment_ledger_source_idx on public.payment_ledger (source_table, source_id);
create index if not exists payment_ledger_paid_at_idx on public.payment_ledger (paid_at);
create index if not exists payment_ledger_payout_idx on public.payment_ledger (payout_id) where payout_id is not null;

-- ---------------------------------------------------------------------------
-- refund_ledger — refunds as PayMongo recorded them
-- ---------------------------------------------------------------------------
-- The platform's own refund columns say what was owed and when an admin marked
-- it sent; this says what PayMongo actually returned. The reconciliation page
-- compares the two.
create table if not exists public.refund_ledger (
  paymongo_refund_id  text primary key,
  paymongo_payment_id text not null references public.payment_ledger (paymongo_payment_id) on delete cascade,
  amount_centavos     int not null,
  status              text,
  refunded_at         timestamptz,
  raw                 jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists refund_ledger_payment_idx on public.refund_ledger (paymongo_payment_id);

-- ---------------------------------------------------------------------------
-- revenue_split_rules — deals that are not the facilitator's plain percentage
-- ---------------------------------------------------------------------------
-- Resolution order for an event charge: event rule → series rule → facilitator
-- rule → events.platform_fee_bps (the pre-existing behaviour). Only one live
-- rule per scope; replacing a rule voids the old row rather than editing it so
-- the history of what was agreed stays readable.
--
--   percent_fee   — Hilom keeps bps/10000 of the charge
--   flat_per_seat — facilitator receives flat_facilitator_centavos per paid
--                   charge (capped at the charge), Hilom keeps the rest
--   hilom_owned   — Hilom keeps everything; no facilitator share
create table if not exists public.revenue_split_rules (
  id                        uuid primary key default gen_random_uuid(),
  scope                     text not null check (scope in ('event', 'event_series', 'facilitator')),
  scope_id                  uuid not null,
  kind                      text not null check (kind in ('percent_fee', 'flat_per_seat', 'hilom_owned')),
  bps                       int check (bps between 0 and 10000),
  flat_facilitator_centavos int check (flat_facilitator_centavos >= 0),
  fee_borne_by              text not null default 'hilom' check (fee_borne_by in ('hilom', 'facilitator')),
  note                      text,
  created_by                text,
  created_at                timestamptz not null default now(),
  voided_at                 timestamptz,
  constraint revenue_split_rules_shape check (
    (kind = 'percent_fee'   and bps is not null) or
    (kind = 'flat_per_seat' and flat_facilitator_centavos is not null) or
    (kind = 'hilom_owned')
  )
);

create unique index if not exists revenue_split_rules_live_uidx
  on public.revenue_split_rules (scope, scope_id) where voided_at is null;

-- Optional reporting category for an event ("Teacher Training" vs "Workshop /
-- Event"). Nothing else reads it; null reports as 'Workshop / Event'.
alter table public.events
  add column if not exists finance_category text;

-- ---------------------------------------------------------------------------
-- reimbursements — money someone fronted for the company
-- ---------------------------------------------------------------------------
create table if not exists public.reimbursements (
  id              uuid primary key default gen_random_uuid(),
  payee           text not null,
  status          text not null default 'owed' check (status in ('owed', 'paid', 'void')),
  paid_at         timestamptz,
  reference       text,
  note            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id                uuid primary key default gen_random_uuid(),
  incurred_on       date not null,
  vendor            text not null,
  description       text not null default '',
  category          text not null check (category in (
                      'Marketing / Advertising', 'Website / Hosting / Software', 'Professional Fees',
                      'Admin / Operations', 'Venue / Event Cost', 'Taxes / Licenses', 'Other')),
  amount_centavos   int not null check (amount_centavos > 0),
  vat_centavos      int not null default 0 check (vat_centavos >= 0),
  paid_by           text not null default 'company',   -- 'company' or a person's name
  payment_method    text,
  event_id          uuid references public.events (id) on delete set null,
  receipt_key       text,
  receipt_name      text,
  reimbursement_id  uuid references public.reimbursements (id) on delete set null,
  status            text not null default 'approved' check (status in ('draft', 'approved', 'void')),
  notes             text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists expenses_incurred_idx on public.expenses (incurred_on);
create index if not exists expenses_reimbursement_idx on public.expenses (reimbursement_id) where reimbursement_id is not null;

-- ---------------------------------------------------------------------------
-- finance_adjustments — manual journal lines for what nothing else captures
-- ---------------------------------------------------------------------------
-- Signed: positive adds to Hilom revenue, negative is a cost. This is also
-- where a change to a closed month lands — in the open month, with a reason.
create table if not exists public.finance_adjustments (
  id               uuid primary key default gen_random_uuid(),
  period           date not null check (extract(day from period) = 1),
  line             text not null check (line in ('revenue', 'payment_costs', 'opex', 'other')),
  amount_centavos  int not null,
  reason           text not null,
  link             text,
  voided_at        timestamptz,
  created_by       text,
  created_at       timestamptz not null default now()
);

create index if not exists finance_adjustments_period_idx on public.finance_adjustments (period);

-- ---------------------------------------------------------------------------
-- finance_periods — month close
-- ---------------------------------------------------------------------------
create table if not exists public.finance_periods (
  period      date primary key check (extract(day from period) = 1),
  status      text not null default 'open' check (status in ('open', 'closed')),
  snapshot    jsonb,
  closed_by   text,
  closed_at   timestamptz,
  reopened_by text,
  reopened_at timestamptz,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- finance_exception_acks — reconciliation findings someone has looked at
-- ---------------------------------------------------------------------------
-- Exceptions are recomputed on every read; an ack keyed by the exception's
-- stable key hides it until its underlying numbers change (the key embeds
-- them).
create table if not exists public.finance_exception_acks (
  key         text primary key,
  note        text,
  acked_by    text,
  acked_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- v_revenue_lines — the sales register
-- ---------------------------------------------------------------------------
-- One row per paid charge. `occurred_at` is when the money landed (cash basis);
-- `service_date` is when the thing sold happens (accrual basis). Hilom share is
-- the platform's own split; a charge with no split is Hilom-owned in full.
create or replace view public.v_revenue_lines
with (security_invoker = true) as
select
  'orders'::text                         as source,
  o.id                                   as source_id,
  o.id                                   as parent_id,
  o.created_at                           as occurred_at,
  o.created_at                           as service_date,
  null::text                             as buyer_name,
  o.buyer_email                          as buyer_email,
  coalesce(p.name, 'Course')             as item,
  'Self-Paced Course'::text              as category,
  null::uuid                             as facilitator_id,
  null::uuid                             as event_id,
  o.amount_centavos                      as gross_centavos,
  coalesce(o.discount_centavos, 0)       as discount_centavos,
  o.amount_centavos                      as hilom_share_centavos,
  0                                      as facilitator_share_centavos,
  false                                  as split_missing,
  o.paymongo_payment_id                  as paymongo_payment_id,
  o.status::text                         as source_status,
  null::uuid                             as payout_id,
  null::uuid                             as clawed_back_payout_id,
  o.currency                             as currency
from public.orders o
left join public.products p on p.id = o.product_id
where o.status <> 'failed'

union all
select
  'registration_charges', c.id, r.id, c.paid_at, coalesce(e.starts_at, c.paid_at),
  r.registrant_name, coalesce(r.buyer_email, r.registrant_email),
  e.title || case when c.label is not null and c.label <> 'Full payment' then ' — ' || c.label else '' end,
  coalesce(e.finance_category, 'Workshop / Event'),
  e.facilitator_id, c.event_id,
  c.amount_centavos, 0,
  coalesce(c.platform_fee_centavos, c.amount_centavos),
  coalesce(c.facilitator_net_centavos, 0),
  (e.facilitator_id is not null and c.facilitator_net_centavos is null),
  c.paymongo_payment_id, c.status::text, c.payout_id, c.clawed_back_payout_id, c.currency
from public.registration_charges c
join public.event_registrations r on r.id = c.registration_id
join public.events e on e.id = c.event_id
where c.status in ('paid', 'refunded') and c.paid_at is not null

union all
select
  'class_registrations', cr.id, cr.id, cr.created_at, coalesce(s.starts_at, cr.created_at),
  cr.client_name, cr.client_email,
  coalesce(fc.title, 'Group class'),
  'Group Class',
  cr.facilitator_id, null::uuid,
  cr.price_centavos, 0,
  cr.platform_fee_centavos, cr.facilitator_net_centavos, false,
  cr.paymongo_payment_id, cr.status::text, cr.payout_id, cr.clawed_back_payout_id, cr.currency
from public.class_registrations cr
left join public.facilitator_class_sessions s on s.id = cr.session_id
left join public.facilitator_classes fc on fc.id = s.class_id
where cr.status::text in ('confirmed', 'completed', 'cancelled')
  and cr.price_centavos > 0
  and cr.paymongo_payment_id is not null

union all
select
  'bookings', b.id, b.id, b.created_at, coalesce(b.starts_at, b.created_at),
  b.client_name, b.client_email,
  coalesce(fs.title, '1:1 session'),
  '1:1 Session',
  b.facilitator_id, null::uuid,
  b.price_centavos, 0,
  b.platform_fee_centavos, b.facilitator_net_centavos, false,
  b.paymongo_payment_id, b.status::text, b.payout_id, b.clawed_back_payout_id, b.currency
from public.bookings b
left join public.facilitator_services fs on fs.id = b.service_id
where b.package_id is null
  and b.status <> 'pending_payment'
  and b.price_centavos > 0

union all
select
  'booking_packages', bp.id, bp.id, bp.created_at, bp.created_at,
  bp.client_name, bp.client_email,
  coalesce(fs.title, 'Session package'),
  '1:1 Session',
  bp.facilitator_id, null::uuid,
  bp.price_centavos, 0,
  bp.platform_fee_centavos, bp.facilitator_net_centavos, false,
  bp.paymongo_payment_id, bp.status::text, null::uuid, null::uuid, bp.currency
from public.booking_packages bp
left join public.facilitator_services fs on fs.id = bp.service_id
where bp.status <> 'pending_payment'
  and bp.price_centavos > 0;

-- ---------------------------------------------------------------------------
-- v_refund_lines — refunds owed and sent, wherever the platform recorded them
-- ---------------------------------------------------------------------------
-- Event refunds live on the registration, not the charge (admin-registrations
-- cancel flow). Course orders have no refund amount: `refunded` means the whole
-- order was returned, and the platform has no sent-date beyond updated_at.
create or replace view public.v_refund_lines
with (security_invoker = true) as
select 'orders'::text as source, o.id as source_id, o.buyer_email as buyer_email,
       coalesce(p.name, 'Course') as item, null::uuid as facilitator_id,
       o.amount_centavos as refund_centavos, o.updated_at as refunded_at, null::text as refund_reference,
       o.updated_at as decided_at, o.paymongo_payment_id
from public.orders o left join public.products p on p.id = o.product_id
where o.status = 'refunded'
union all
select 'event_registrations', r.id, coalesce(r.buyer_email, r.registrant_email),
       e.title, e.facilitator_id,
       r.refund_centavos, r.refunded_at, r.refund_reference,
       coalesce(r.cancelled_at, r.updated_at),
       (select c.paymongo_payment_id from public.registration_charges c
         where c.registration_id = r.id and c.paid_at is not null order by c.paid_at limit 1)
from public.event_registrations r join public.events e on e.id = r.event_id
where r.refund_centavos > 0
union all
select 'class_registrations', cr.id, cr.client_email, coalesce(fc.title, 'Group class'), cr.facilitator_id,
       cr.refund_centavos, cr.refunded_at, cr.refund_reference, coalesce(cr.cancelled_at, cr.updated_at),
       cr.paymongo_payment_id
from public.class_registrations cr
left join public.facilitator_class_sessions s on s.id = cr.session_id
left join public.facilitator_classes fc on fc.id = s.class_id
where cr.refund_centavos > 0
union all
select 'bookings', b.id, b.client_email, coalesce(fs.title, '1:1 session'), b.facilitator_id,
       b.refund_centavos, b.refunded_at, b.refund_reference, coalesce(b.cancelled_at, b.updated_at),
       b.paymongo_payment_id
from public.bookings b left join public.facilitator_services fs on fs.id = b.service_id
where b.refund_centavos > 0
union all
select 'booking_packages', bp.id, bp.client_email, coalesce(fs.title, 'Session package'), bp.facilitator_id,
       bp.refund_centavos, null::timestamptz, null::text, coalesce(bp.cancelled_at, bp.updated_at),
       bp.paymongo_payment_id
from public.booking_packages bp left join public.facilitator_services fs on fs.id = bp.service_id
where bp.refund_centavos > 0;

-- ---------------------------------------------------------------------------
-- Grants and RLS: backend-only, like every money table
-- ---------------------------------------------------------------------------
alter table public.payment_ledger         enable row level security;
alter table public.refund_ledger          enable row level security;
alter table public.revenue_split_rules    enable row level security;
alter table public.reimbursements         enable row level security;
alter table public.expenses               enable row level security;
alter table public.finance_adjustments    enable row level security;
alter table public.finance_periods        enable row level security;
alter table public.finance_exception_acks enable row level security;

revoke all on public.payment_ledger, public.refund_ledger, public.revenue_split_rules,
              public.reimbursements, public.expenses, public.finance_adjustments,
              public.finance_periods, public.finance_exception_acks,
              public.v_revenue_lines, public.v_refund_lines
  from anon, authenticated;

grant select, insert, update, delete on public.payment_ledger, public.refund_ledger,
  public.revenue_split_rules, public.reimbursements, public.expenses,
  public.finance_adjustments, public.finance_periods, public.finance_exception_acks
  to service_role;
grant select on public.v_revenue_lines, public.v_refund_lines to service_role;

-- Package instalments (Canny: "Group Packages – Installment Payments &
-- Session Scheduling").
--
-- A package service may offer an instalment plan alongside full payment. The
-- plan is a list of payments, each with an amount and the session number it
-- must be paid before; the first is always due at checkout (due_session = 1).
-- Stored on the service as JSON and validated in the app
-- (lib/package-installments.ts), then snapshotted per purchase as
-- package_charges rows, so editing the plan later never moves what a buyer
-- agreed to.
--
-- Due dates are not stored. A charge is due on the start of the package's
-- Nth live session (by start time), worked out when needed. Rescheduling a
-- session therefore moves its payment and its reminders with no extra code,
-- and a payment tied to a session nobody has booked yet has no due date and
-- sends no reminders until it does.
--
-- Money: the facilitator still earns per delivered session (0035). Finance
-- records an instalment package's revenue per payment as it clears, not the
-- full price at purchase (v_revenue_lines below).

alter table public.facilitator_services
  add column if not exists installment_plan jsonb;

comment on column public.facilitator_services.installment_plan is
  'Null = full payment only. Else [{amount_centavos, due_session}], first due_session = 1, amounts sum to price_centavos. Validated in lib/package-installments.ts.';

alter table public.booking_packages
  add column if not exists plan_kind text not null default 'full'
    check (plan_kind in ('full', 'installment'));

create table if not exists public.package_charges (
  id                  uuid primary key default gen_random_uuid(),
  package_id          uuid not null references public.booking_packages(id) on delete cascade,
  seq                 int not null check (seq > 0),
  label               text not null,
  amount_centavos     int not null check (amount_centavos > 0),
  currency            text not null default 'PHP',
  -- Paid before this session (1-based, by start time among live sessions).
  due_session         int not null check (due_session > 0),
  status              public.charge_status not null default 'scheduled',
  -- The platform's split of this payment, in proportion to the package's.
  platform_fee_centavos    int not null default 0 check (platform_fee_centavos >= 0),
  facilitator_net_centavos int not null default 0 check (facilitator_net_centavos >= 0),
  paid_at             timestamptz,
  paymongo_payment_id text unique,
  paymongo_session_id text,
  checkout_url        text,
  checkout_expires_at timestamptz,
  flagged_overdue_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (package_id, seq)
);

drop trigger if exists package_charges_set_updated_at on public.package_charges;
create trigger package_charges_set_updated_at
  before update on public.package_charges
  for each row execute function public.set_updated_at();

create index if not exists package_charges_open_idx
  on public.package_charges (status)
  where status in ('scheduled', 'awaiting_payment');

-- One row per reminder sent; the unique index makes the insert the claim,
-- the same pattern as registration_charge_reminders (0017).
create table if not exists public.package_charge_reminders (
  id         uuid primary key default gen_random_uuid(),
  charge_id  uuid not null references public.package_charges(id) on delete cascade,
  tier       text not null check (tier in ('7d', '3d', 'day_of')),
  due_at     timestamptz not null,
  sent_at    timestamptz not null default now(),
  unique (charge_id, tier, due_at)
);

alter table public.package_charges          enable row level security;
alter table public.package_charge_reminders enable row level security;
revoke all on public.package_charges, public.package_charge_reminders from anon, authenticated;
grant select, insert, update, delete on public.package_charges, public.package_charge_reminders to service_role;

-- The ledger may now point at a package instalment.
alter table public.payment_ledger drop constraint if exists payment_ledger_source_table_check;
alter table public.payment_ledger add constraint payment_ledger_source_table_check
  check (source_table in ('orders', 'registration_charges', 'class_registrations', 'bookings',
                          'booking_packages', 'package_charges', 'unknown'));

-- v_revenue_lines, redefined from 0070: full-payment packages unchanged,
-- instalment packages counted per cleared payment.
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
  and bp.price_centavos > 0
  and bp.plan_kind = 'full'

union all
-- An instalment package: one line per payment, when it clears (0077).
select
  'package_charges', pc.id, bp.id, pc.paid_at, pc.paid_at,
  bp.client_name, bp.client_email,
  coalesce(fs.title, 'Session package') || ' — ' || pc.label,
  '1:1 Session',
  bp.facilitator_id, null::uuid,
  pc.amount_centavos, 0,
  pc.platform_fee_centavos, pc.facilitator_net_centavos, false,
  pc.paymongo_payment_id, pc.status::text, null::uuid, null::uuid, pc.currency
from public.package_charges pc
join public.booking_packages bp on bp.id = pc.package_id
left join public.facilitator_services fs on fs.id = bp.service_id
where pc.status in ('paid', 'refunded') and pc.paid_at is not null;


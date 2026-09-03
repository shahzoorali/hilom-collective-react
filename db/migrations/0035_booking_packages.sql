-- Multi-session packages: sell six sessions once, schedule them one at a time.
--
-- `service_kind = 'package'` has existed since 0011 — validated `sessions_count`,
-- stored on the service, rendered on the profile as "· 6 sessions" — but
-- `POST /bookings` never read it: buying a package charged the whole price and
-- created exactly *one* booking, with no way to schedule the rest. That is
-- charging for sessions the system cannot deliver, so the kind was closed at
-- the point of sale (SELLABLE_SERVICE_KINDS in facilitator-input.ts) until the
-- missing half existed. This is that half.
--
-- Coaching, therapy-adjacent work and structured programmes are almost always
-- sold as blocks — "6 sessions", "a 3-month container". Without this a
-- facilitator running a real programme sells six separate things and hopes the
-- client books all six.
--
-- ---------------------------------------------------------------------------
-- The money, which is the part with a decision in it
-- ---------------------------------------------------------------------------
-- The shape decided on 2026-08-23 and recorded in facilitator-input.ts: the
-- package price is split across its N sessions, and the facilitator earns each
-- share as that session is *delivered*.
--
-- The alternative — pay the whole package out on purchase — was rejected for
-- two reasons that both bite in practice. A client who takes two of six
-- sessions and stops would have had six paid out, so a refund becomes money
-- Hilom has to claw back from a facilitator it has already sent. And the payout
-- pipeline is built on "sum the delivered bookings", which keeps working
-- unchanged if each session carries its own share and needs rewriting if
-- packages are a second, parallel source of earnings.
--
-- So the package row records what was actually charged, and each booking
-- created against it carries a share that sums back to it exactly. See
-- `splitPackageSessions` in backend/src/lib/booking-domain.ts for the
-- arithmetic and why the shares are computed by running total rather than by
-- dividing and patching the remainder.
--
-- Nothing needed migrating: no package service or booking has ever existed in
-- production.

-- pending_payment — checkout started, no credits yet
-- active          — paid; credits may be scheduled
-- cancelled       — abandoned checkout, reclaimed
-- refunded        — unused credits returned; recorded, money moved by hand,
--                   consistent with every other refund here
do $$ begin
  create type public.package_status as enum
    ('pending_payment', 'active', 'cancelled', 'refunded');
exception when duplicate_object then null;
end $$;

create table if not exists public.booking_packages (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete restrict,
  -- restrict, like bookings: deleting a service must not erase what someone
  -- paid for. Services are deactivated, not deleted.
  service_id     uuid not null references public.facilitator_services(id) on delete restrict,

  -- The buyer, identified exactly as everywhere else: a verified email, with
  -- the Cognito sub alongside because an address can change.
  client_email       text not null,
  client_cognito_sub text,
  client_name        text,
  client_timezone    text,

  -- Snapshotted at purchase, for the same reason the booking's are (0012): a
  -- service repriced in October must not change what a package bought in
  -- August was worth. `sessions_total` in particular is the credit count and
  -- must never move.
  sessions_total          int  not null check (sessions_total between 2 and 50),
  price_centavos          int  not null check (price_centavos >= 0),
  platform_fee_centavos   int  not null default 0 check (platform_fee_centavos >= 0),
  facilitator_net_centavos int not null default 0 check (facilitator_net_centavos >= 0),
  currency                text not null default 'PHP',

  status         public.package_status not null default 'pending_payment',

  paymongo_payment_id text unique,
  paymongo_session_id text,

  -- The refund policy in force when it was bought, snapshotted like a
  -- booking's (0027). Applies to the *package*; an individual session
  -- cancelled inside a package returns a credit rather than money.
  refund_full_hours int,
  refund_half_hours int,

  cancelled_at    timestamptz,
  cancellation_reason text,
  refund_centavos int check (refund_centavos >= 0),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists booking_packages_set_updated_at on public.booking_packages;
create trigger booking_packages_set_updated_at
  before update on public.booking_packages
  for each row execute function public.set_updated_at();

-- "What have I bought and what is left on it" — the client's own list.
create index if not exists booking_packages_client_idx
  on public.booking_packages (lower(client_email), created_at desc);

create index if not exists booking_packages_facilitator_idx
  on public.booking_packages (facilitator_id, status);

-- Which package a session was scheduled against, and therefore which credit it
-- spent. Null for every ordinary booking.
--
-- `on delete restrict` in the other direction is unnecessary — a package is
-- never deleted — but the FK matters: counting remaining credits is a count of
-- live bookings carrying this id, and a dangling reference would mean selling
-- someone a credit they had already used.
alter table public.bookings
  add column if not exists package_id uuid references public.booking_packages(id) on delete set null;

-- The credit count. Partial, because the column is null on almost every row.
create index if not exists bookings_package_idx
  on public.bookings (package_id)
  where package_id is not null;

-- No RLS change. `booking_packages` is backend-only like `bookings`: the only
-- readers are handlers that scope by the verified caller's email or by their
-- own facilitator id.
alter table public.booking_packages enable row level security;

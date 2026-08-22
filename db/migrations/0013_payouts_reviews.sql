-- Facilitator marketplace, part 3 of 3: the earnings ledger and reviews.
--
-- Payout design:
--   Hilom collects the full amount through the existing PayMongo checkout and
--   transfers each facilitator's share manually. This table is the ledger that
--   makes that defensible — a facilitator can see exactly which bookings make
--   up a payment, and Hilom has a record of what was sent and when.
--
--   It is deliberately shaped so that automatic split payments (PayMongo
--   Platforms, Xendit) can be dropped in later without a redesign: when a
--   processor starts splitting at charge time, a payout row stops being
--   "what we owe" and becomes "what the processor settled", and `reference`
--   holds their transfer id instead of a bank reference. The per-booking
--   fee split already lives on the booking row either way.
--
--   Batches are period-based rather than per-booking because that is how the
--   money actually moves: one transfer covering a fortnight, not thirty.

do $$ begin
  create type public.payout_status as enum ('draft', 'approved', 'paid', 'void');
exception when duplicate_object then null;
end $$;

create table if not exists public.facilitator_payouts (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete restrict,

  -- The window whose completed bookings this batch covers. Half-open in
  -- practice ([start, end)) so consecutive periods cannot double-count a
  -- booking that lands exactly on the boundary.
  period_start   timestamptz not null,
  period_end     timestamptz not null,

  -- All denormalized at batch time from the member bookings. Recomputing these
  -- on read would make a historical payout drift if a booking is later
  -- refunded, which is precisely what a ledger must not do.
  gross_centavos          int not null default 0,
  platform_fee_centavos   int not null default 0,
  -- Payment-processor cost attributed to this batch. Entered by an admin
  -- rather than derived: PayMongo's fee is per-transaction and is not exposed
  -- on the webhook payload, so guessing it here would be fiction.
  processing_fee_centavos int not null default 0,
  net_centavos            int not null default 0,
  currency                text not null default 'PHP',

  status         public.payout_status not null default 'draft',
  paid_at        timestamptz,
  -- Bank transfer reference today; a processor transfer id after a migration
  -- to split payments.
  reference      text,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint facilitator_payouts_period check (period_end > period_start)
);

create index if not exists facilitator_payouts_facilitator_idx
  on public.facilitator_payouts (facilitator_id, period_end desc);

create index if not exists facilitator_payouts_status_idx
  on public.facilitator_payouts (status, period_end desc);

drop trigger if exists facilitator_payouts_set_updated_at on public.facilitator_payouts;
create trigger facilitator_payouts_set_updated_at
  before update on public.facilitator_payouts
  for each row execute function public.set_updated_at();

-- Membership lives on the booking rather than in a join table: a booking
-- belongs to at most one payout, so a join table would buy nothing and make
-- "has this been paid out yet?" a second query on the hottest path in the
-- earnings screen. Added here rather than in 0012 only because the referenced
-- table does not exist until now.
alter table public.bookings
  add column if not exists payout_id uuid references public.facilitator_payouts(id) on delete set null;

-- The batch-builder query: everything for this facilitator not yet paid out.
create index if not exists bookings_unpaid_idx
  on public.bookings (facilitator_id, ends_at)
  where payout_id is null;

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
-- Created now so that the booking lifecycle has somewhere to point; the UI is
-- Phase 2. Moderated rather than published on write — this is a small, curated
-- roster of named practitioners, not a volume marketplace, and one abusive
-- review left up for an afternoon is a real problem for a real person.
--
-- Keyed on booking_id and unique on it: a review must be earned by an actual
-- completed session, and one session yields one review. That single constraint
-- is what keeps this from becoming a ratings-brigading surface.
do $$ begin
  create type public.review_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

create table if not exists public.facilitator_reviews (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null unique references public.bookings(id) on delete cascade,
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,
  rating         int not null check (rating between 1 and 5),
  comment        text,
  -- Denormalized so an approved review can be shown as "Maria C." without
  -- joining back to a booking row that holds the full email.
  client_label   text,
  status         public.review_status not null default 'pending',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists facilitator_reviews_facilitator_idx
  on public.facilitator_reviews (facilitator_id, status, created_at desc);

drop trigger if exists facilitator_reviews_set_updated_at on public.facilitator_reviews;
create trigger facilitator_reviews_set_updated_at
  before update on public.facilitator_reviews
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
--
-- Payouts are money and are backend-only, like orders and bookings. Approved
-- reviews are public by nature, so they follow the published-content pattern
-- used by pages and events.
-- ---------------------------------------------------------------------------
alter table public.facilitator_payouts enable row level security;
revoke all on public.facilitator_payouts from anon, authenticated;

alter table public.facilitator_reviews enable row level security;
-- booking_id is deliberately outside this grant: it would let anyone walk an
-- approved review back to a specific booking row.
grant select (id, facilitator_id, rating, comment, client_label, status, created_at)
  on public.facilitator_reviews to anon, authenticated;

drop policy if exists facilitator_reviews_public_read on public.facilitator_reviews;
create policy facilitator_reviews_public_read
  on public.facilitator_reviews for select
  to anon, authenticated
  using (status = 'approved');

grant select, insert, update, delete
  on public.facilitator_payouts, public.facilitator_reviews
  to service_role;

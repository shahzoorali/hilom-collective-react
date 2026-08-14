-- Phase 3 — core schema.
--
-- Design notes:
--  * Money is stored in centavos as an integer. Never use float for money, and
--    PayMongo's API is centavo-denominated too, so this avoids conversion at the
--    boundary.
--  * `orders` is the durable money record. It is written BEFORE any enrollment is
--    attempted, so a "paid but not enrolled" state is always recoverable rather
--    than lost. Fulfillment status lives in the same row.
--  * Bundles are not a special case: `product_courses` maps one product to N
--    courses, so a single course and a bundle are the same shape.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- products — what a customer can buy
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,
  slug            text        not null unique,
  description     text,
  price_centavos  integer     not null check (price_centavos >= 0),
  currency        text        not null default 'PHP',
  thumbnail_url   text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.products.price_centavos is
  'Integer centavos, e.g. 149900 = PHP 1,499.00. Never store money as float.';

-- ---------------------------------------------------------------------------
-- courses — read-only cache synced from Moodle (Phase 5)
-- ---------------------------------------------------------------------------
create table if not exists public.courses (
  moodle_course_id integer primary key,
  fullname         text not null,
  shortname        text not null,
  summary          text,
  visible          boolean not null default true,
  last_synced_at   timestamptz not null default now()
);

comment on table public.courses is
  'Cache of Moodle course metadata. Sync is manual (Phase 5), so last_synced_at '
  'must be surfaced in the admin UI to make staleness visible.';

-- ---------------------------------------------------------------------------
-- product_courses — product -> Moodle course mapping (handles bundles)
-- ---------------------------------------------------------------------------
create table if not exists public.product_courses (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid    not null references public.products(id) on delete cascade,
  moodle_course_id integer not null,
  created_at       timestamptz not null default now(),
  -- Enrolling the same course twice for one product would be a silent data bug.
  unique (product_id, moodle_course_id)
);

-- Deliberately NOT a foreign key to courses.moodle_course_id: the courses table
-- is a cache that can be empty or stale, and a missing cache row must never block
-- a sale or an enrollment.
create index if not exists product_courses_product_id_idx
  on public.product_courses(product_id);

-- ---------------------------------------------------------------------------
-- orders — durable money record + fulfillment status
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.order_status as enum (
    'paid_pending_enrollment',  -- money recorded, access not yet granted
    'fulfilled',                -- enrolled in every course for the product
    'failed',                   -- enrollment exhausted retries; needs admin action
    'refunded'                  -- refunded in PayMongo and access revoked
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  -- Unique: this is the webhook dedupe key. PayMongo can and does deliver the
  -- same event more than once, and a duplicate must not create a second order.
  paymongo_payment_id  text not null unique,
  product_id           uuid not null references public.products(id),
  buyer_email          text not null,
  amount_centavos      integer not null check (amount_centavos >= 0),
  currency             text not null default 'PHP',
  status               public.order_status not null default 'paid_pending_enrollment',
  cognito_user_sub     text,
  moodle_user_id       integer,
  error_detail         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- The admin "stuck orders" view and the retry consumer both filter on status.
create index if not exists orders_status_idx     on public.orders(status);
create index if not exists orders_buyer_email_idx on public.orders(buyer_email);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
-- Empty search_path: this runs as the table owner, so an attacker-controlled
-- search_path must not be able to resolve `now()` to something else.
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

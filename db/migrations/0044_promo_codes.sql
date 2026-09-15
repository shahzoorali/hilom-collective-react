-- Promo codes — percentage or fixed-amount discounts applied at checkout.
--
-- A code is resolved and its discount computed server-side in checkout.ts,
-- the same "never trust the client with money" rule products already follow.
-- `orders.discount_centavos` records what was actually knocked off at the time
-- of purchase, and `orders.promo_code_id` is nullable + ON DELETE SET NULL so
-- deleting a code later never touches the historical order row — the money
-- record must outlive the code that produced it.

do $$ begin
  create type public.promo_discount_type as enum ('percent', 'fixed');
exception when duplicate_object then null;
end $$;

create table if not exists public.promo_codes (
  id              uuid primary key default gen_random_uuid(),
  -- Stored upper-cased so "kuya10" and "KUYA10" are the same code; lookups
  -- normalize the same way.
  code            text not null unique,
  -- Who/what the code is for, e.g. "Jonathan Brown" or "Netflix" — shown in
  -- the admin list, never shown to the buyer.
  label           text,
  discount_type   public.promo_discount_type not null,
  -- Percent: 1-100. Fixed: centavos, >= 0. Enforced per-type below rather than
  -- with one shared range, since "100" means very different things for each.
  discount_value  integer not null,
  is_active       boolean not null default true,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint promo_codes_discount_value_check check (
    (discount_type = 'percent' and discount_value between 1 and 100) or
    (discount_type = 'fixed' and discount_value >= 0)
  )
);

create index if not exists promo_codes_active_idx on public.promo_codes(is_active);

drop trigger if exists promo_codes_set_updated_at on public.promo_codes;
create trigger promo_codes_set_updated_at
  before update on public.promo_codes
  for each row execute function public.set_updated_at();

alter table public.orders
  add column if not exists promo_code_id uuid references public.promo_codes(id) on delete set null,
  add column if not exists discount_centavos integer not null default 0 check (discount_centavos >= 0);

-- Every table the backend reads/writes needs an explicit service_role grant —
-- Supabase does not hand one out by default (see 0039's note on this exact
-- omission causing a 42501 on other tables). promo_codes has no RLS policies
-- and none are needed: the only path to a row is the backend's own handlers.
grant select, insert, update, delete on public.promo_codes to service_role;

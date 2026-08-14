-- Phase 3 — Row Level Security.
--
-- Threat model: the publishable key ships inside the React bundle and is public.
-- Anyone can read it and call the REST API as the `anon` role. So `anon` must be
-- able to read the catalog and nothing else — in particular it must never be able
-- to read `orders`, which holds buyer emails and payment IDs.
--
-- The backend uses the secret key (`service_role`), which bypasses RLS entirely.
-- That is why every order write path lives in Lambda and never in the frontend.

-- ---------------------------------------------------------------------------
-- Catalog: publicly readable
-- ---------------------------------------------------------------------------
alter table public.products        enable row level security;
alter table public.courses         enable row level security;
alter table public.product_courses enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.products, public.courses, public.product_courses
  to anon, authenticated;

drop policy if exists products_public_read on public.products;
create policy products_public_read
  on public.products for select
  to anon, authenticated
  -- Inactive products are hidden from the catalog rather than deleted, so that
  -- historical orders keep a valid product_id foreign key.
  using (is_active);

drop policy if exists courses_public_read on public.courses;
create policy courses_public_read
  on public.courses for select
  to anon, authenticated
  using (true);

-- Needed so a bundle's product page can list the courses it contains.
drop policy if exists product_courses_public_read on public.product_courses;
create policy product_courses_public_read
  on public.product_courses for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.products p
      where p.id = product_courses.product_id
        and p.is_active
    )
  );

-- ---------------------------------------------------------------------------
-- Orders: backend-only. RLS is enabled with NO policy for anon/authenticated,
-- which denies every row. Grants are revoked too, so a future permissive policy
-- added by mistake still would not expose the table.
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;

revoke all on public.orders from anon, authenticated;

-- Defensive: Supabase's default privileges grant new tables to anon, so an
-- unqualified `grant all` in a later migration could silently re-expose orders.
alter default privileges in schema public revoke all on tables from anon;

-- ---------------------------------------------------------------------------
-- service_role (the backend secret key) needs explicit table privileges.
--
-- Bypassing RLS is NOT the same as having privileges: without these grants
-- every backend read and write fails with 42501 "permission denied", including
-- the order-first write in the payment webhook. Supabase's default privileges
-- did not cover tables created through this migration path.
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete
  on public.products, public.courses, public.product_courses, public.orders
  to service_role;
grant usage, select on all sequences in schema public to service_role;

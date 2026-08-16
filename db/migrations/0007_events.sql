-- Managed events, replacing hand-authored imageCardGrid blocks on the Events page.
--
-- Design notes:
--  * A dedicated table, not blocks in a page's JSONB — unlike page content,
--    events are structured records with real dates that need sorting and
--    upcoming/past logic. That logic has to run in SQL or in the handler
--    either way, so storing events as opaque block props (like the old
--    imageCardGrid) would mean parsing dates back out of free text on every
--    request. A table with `starts_at timestamptz` makes "upcoming first,
--    then past" a single ORDER BY.
--  * Reuses public.page_status (draft/published) from 0006_cms.sql — same
--    semantics: an admin can build an event before it's visible, same as a
--    page. No separate enum needed for an identical two-value state.
--  * No capacity/ticketing columns. This is a listing tool, not a checkout —
--    if paid ticketing is ever needed, it is closer to the products/orders
--    schema in 0001_initial_schema.sql than to this table.

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  subtitle    text,
  -- Sanitized HTML, same treatment as page rich-text blocks
  -- (backend/src/lib/sanitize.ts) — allowlisted on write, trusted on render.
  description text,
  image_id    uuid references public.media_assets(id) on delete set null,
  image_url   text,
  image_alt   text,
  -- Free text ("Via Zoom", "Manila Hotel, 2F") rather than a structured
  -- address: every event on the live site to date is either fully virtual or
  -- a single venue line, and geocoding is not a problem this tool has.
  location    text,
  starts_at   timestamptz not null,
  -- Nullable: a one-line "3:00 PM" event has no meaningful end time. Where
  -- present, it is what decides when the event moves to Past — a two-day
  -- event should not disappear from Upcoming after day one starts.
  ends_at     timestamptz,
  link_url    text,
  link_label  text,
  -- The highlighted note style ("Use code: HILOM for 10% off") from the
  -- original hand-authored cards.
  note        text,
  status      public.page_status not null default 'draft',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.events.ends_at is
  'Drives Upcoming vs Past: an event is past once coalesce(ends_at, starts_at) < now().';

-- The public list endpoint always orders by this and filters on status; a
-- composite index matches that query shape exactly.
create index if not exists events_status_starts_at_idx on public.events(status, starts_at);

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — same shape as pages: anon reads published rows only; the backend
-- (service_role) has full access via the secret key, which bypasses RLS but
-- still needs explicit grants (see the note in 0002_rls.sql).
-- ---------------------------------------------------------------------------
alter table public.events enable row level security;

grant select on public.events to anon, authenticated;

drop policy if exists events_public_read on public.events;
create policy events_public_read
  on public.events for select
  to anon, authenticated
  using (status = 'published');

grant select, insert, update, delete on public.events to service_role;

-- A views → checkouts → sales funnel per event date (0054, Phase 3).
--
-- "Checkouts" and "sales" already exist in the data — every attempt at a seat
-- is an `event_registrations` row regardless of what became of it (0016's
-- sweep sets an abandoned hold to `expired` rather than deleting it, exactly
-- so this kind of count stays honest), and a sale is one whose status reached
-- `confirmed` or `completed`. Views are the one number nothing here has ever
-- recorded, because nothing tracks a page load at all yet.
--
-- ===========================================================================
-- What this counter is, and is not
-- ===========================================================================
-- `view_count` is a raw hit counter, incremented once per load of the ticket
-- page (`GET /events/{id}/ticketing`, the one call `EventRegister.tsx` makes).
-- It is not unique visitors: a refresh counts again, and there is no bot
-- filtering. That is a deliberate, cheap starting point — a real unique-visitor
-- count needs a sessions/visits table and a decision about what "unique" means
-- over what window, which is a bigger feature than a facilitator asking "is
-- anyone looking at this event" needs answered today.
alter table public.events
  add column if not exists view_count int not null default 0 check (view_count >= 0);

comment on column public.events.view_count is
  'Raw hits on this date''s ticket page (0063) — not unique visitors. '
  'Incremented by increment_event_view() on every GET .../ticketing.';

-- A tiny atomic increment, the same reason claim_event_seat and
-- replace_event_plans are functions rather than a read-then-write from the
-- handler: two concurrent page loads must both count, not race and drop one.
create or replace function public.increment_event_view(p_event_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.events set view_count = view_count + 1 where id = p_event_id;
$$;

revoke all on function public.increment_event_view(uuid) from public, anon, authenticated;
grant execute on function public.increment_event_view(uuid) to service_role;

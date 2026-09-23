-- Grants and row-level security for the two tables 0055 and 0060 created.
--
-- Neither migration granted anything, so the backend's service_role could not
-- read or write them — the first live call to /admin/event-series failed with
-- permission denied. The service role bypasses RLS but still needs explicit
-- table privileges (db/README.md, and the same note in 0049).
--
-- Both tables are backend-only: event_series holds a facilitator's proposed
-- price, and event_waitlist holds buyers' emails and phone numbers. So RLS is
-- enabled with no policy, and anon/authenticated are revoked, the same layered
-- default `orders` uses — both have to fail before either leaks to the
-- publishable key that ships in the React bundle.
alter table public.event_series   enable row level security;
alter table public.event_waitlist enable row level security;

revoke all on public.event_series   from anon, authenticated;
revoke all on public.event_waitlist from anon, authenticated;

grant select, insert, update, delete on public.event_series   to service_role;
grant select, insert, update, delete on public.event_waitlist to service_role;

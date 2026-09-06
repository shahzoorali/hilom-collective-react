-- Grant service_role the table privileges that 0033, 0034 and 0035 left out.
--
-- Those three migrations enabled RLS on their tables and stopped there, on the
-- assumption that the backend's service key needs nothing further. It does:
-- as 0002_rls.sql spells out, "bypassing RLS is NOT the same as having
-- privileges" — service_role still needs an explicit table grant, and Supabase's
-- default privileges do not hand it one. Every other feature migration
-- (0006, 0007, 0008, 0011, 0012, 0013, 0016, 0025 …) carries the grant; these
-- three are the only omissions.
--
-- The effect of the omission: since 0033–0035 were applied (2026-09-04) every
-- backend read or write of these tables has failed with SQLSTATE 42501
-- "permission denied", surfacing as a 500 on the facilitator Clients tab, the
-- Messages tab and message send, and on GET /me/packages for clients.
--
-- Append-only: 0033–0035 are already applied, so the fix is a new migration
-- rather than an edit to files the database has diverged from.
--
-- RLS stays enabled and policy-less on all three, exactly as those migrations
-- intended — the only path to a row is still the backend service key inside a
-- handler that has already checked the caller. This grant just lets that path
-- reach the table at all.

grant select, insert, update, delete on public.facilitator_clients to service_role;
grant select, insert, update, delete on public.booking_messages    to service_role;
grant select, insert, update, delete on public.booking_packages     to service_role;

-- Matches the trailing line every prior grant migration carries: any sequences
-- these tables introduced (e.g. serial columns) are covered too. Harmless where
-- there are none.
grant usage, select on all sequences in schema public to service_role;

-- Two things a hosted event needs that it has had no place to put: who is
-- actually running it, and how an attendee joins it.
--
-- **Why a column and not events.facilitators.**
-- 0018 added `events.facilitators` — a JSONB roster of {name, title, bio,
-- photo_url}. That is display copy, deliberately: a guest speaker who will
-- never have a login still needs a headshot on the page, and giving them a
-- facilitators row to get one would be worse. But display copy cannot answer
-- either question asked here. "Show Prem's hosted events on his profile" and
-- "let Prem see who registered" are both authorization questions, and matching
-- a marketplace facilitator to a roster entry by name is not an answer — two
-- people share a name, a typo silently unlinks an event, and an edit to a bio
-- would change who can read a roster. So: a real FK, nullable, alongside the
-- roster rather than replacing it. An event may have five names on the page
-- and exactly one host account behind it.
--
-- ON DELETE SET NULL, not restrict: removing a facilitator from the
-- marketplace must not be blocked by an event they once ran, and the event's
-- own `facilitators` roster still carries their name for the public page.
--
-- **Why join_url is not venue_details.**
-- `venue_details` is already returned by GET /events/{id}/ticketing
-- (handlers/events.ts TICKETING_COLUMNS) — it is public, pre-payment copy that
-- renders on the registration page. A Zoom link put there is a published open
-- door into the event. `join_url` is a separate column precisely so it can be
-- withheld from every public read and released only to a confirmed registrant,
-- the same call 0011 made for facilitator_services.meeting_url and that
-- handlers/facilitators.ts:150 explains.

alter table public.events
  add column if not exists facilitator_id uuid
    references public.facilitators(id) on delete set null,
  add column if not exists join_url          text,
  add column if not exists join_instructions text;

comment on column public.events.facilitator_id is
  'The marketplace facilitator hosting this event, if one is. Drives the "Hosting" '
  'section on their public profile and their access to this event''s roster and join link. '
  'Distinct from events.facilitators (0018), which is display copy for the event page.';
comment on column public.events.join_url is
  'Joining link (Zoom/Meet) for a virtual event. NEVER include this in a public '
  'read — it is released to confirmed registrants by email and on their own '
  'registration page, and is editable by an admin or by events.facilitator_id.';
comment on column public.events.join_instructions is
  'Free text shown alongside join_url ("dial-in +63 2 ...", "waiting room opens 15 min early").';

-- The two queries this column exists for: "which events is this facilitator
-- hosting" (their profile, their dashboard) and nothing else. Partial on
-- not-null because the overwhelming majority of rows never get a host.
create index if not exists events_facilitator_id_idx
  on public.events (facilitator_id, starts_at desc)
  where facilitator_id is not null;

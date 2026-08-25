-- A short, admin-written summary for event listing cards.
--
-- The events grid (frontend/src/cms/BlockRenderer.tsx EventCard) used to
-- render the full `description` HTML on every card, which is fine for a
-- one-liner but unusable once an event's description runs to several
-- paragraphs (see the "Return to Self" retreat's day-by-day itinerary).
-- `excerpt` lets an admin write a short blurb for the card; when it is left
-- blank the frontend falls back to the description's first paragraph rather
-- than the whole thing, so nothing breaks for events that predate this column.
alter table public.events add column if not exists excerpt text;

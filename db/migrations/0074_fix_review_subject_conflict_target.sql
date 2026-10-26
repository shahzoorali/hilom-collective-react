-- Fix: event and class reviews cannot save (internal server error).
--
-- 0050 replaced the single `unique` on booking_id with three *partial* unique
-- indexes (one per subject column, each `where <column> is not null`), so
-- that a column being null in two rows wouldn't collide. But PostgREST's
-- upsert only ever emits `ON CONFLICT (<column>) DO UPDATE ...` — it has no
-- way to also restate an index's WHERE predicate in that clause, and without
-- a matching predicate Postgres won't pick a partial index as the arbiter.
-- Every upsert where the conflict target was event_registration_id or
-- class_registration_id therefore failed with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" — exactly
-- what surfaced as a generic 500 to the client. booking_id reviews happened
-- to predate 0050 structurally but share the same broken shape now.
--
-- Fix: one real (non-partial) unique index that PostgREST can target
-- regardless of which subject is set. `facilitator_reviews_one_subject`
-- (0050) already guarantees exactly one of the three columns is non-null, so
-- coalescing them gives one well-defined id per review, unique across all
-- three subject tables combined (a collision would need a booking, an event
-- registration and a class registration to share a v4 UUID — not a real
-- risk). The generated column is what `onConflict` now names, independent of
-- which subject type a given review is about.

alter table public.facilitator_reviews
  add column if not exists subject_id uuid
  generated always as (
    coalesce(booking_id, event_registration_id, class_registration_id)
  ) stored;

drop index if exists public.facilitator_reviews_booking_idx;
drop index if exists public.facilitator_reviews_event_registration_idx;
drop index if exists public.facilitator_reviews_class_registration_idx;

create unique index if not exists facilitator_reviews_subject_idx
  on public.facilitator_reviews (subject_id);

comment on column public.facilitator_reviews.subject_id is
  'coalesce(booking_id, event_registration_id, class_registration_id); exists '
  'only so one real (non-partial) unique index can back the review upsert''s '
  'onConflict target — see 0074. Not meant to be queried directly.';

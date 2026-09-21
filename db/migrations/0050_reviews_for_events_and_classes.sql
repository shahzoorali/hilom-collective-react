-- Let a review be about an event or a group class, not only a 1:1 booking.
--
-- The review machinery is already built end to end: submission from the
-- client's bookings screen, moderation in admin, aggregates maintained by
-- trigger (0036), and a rating on every directory card. The only thing it
-- cannot do is attach to anything but a booking:
--
--   booking_id uuid not null unique references public.bookings(id)
--
-- ---------------------------------------------------------------------------
-- The subject becomes polymorphic, with exactly one of three set
-- ---------------------------------------------------------------------------
-- Three nullable FKs and a CHECK, rather than a (subject_type, subject_id)
-- pair. The pair is smaller to write and gives up the thing that matters: a
-- real foreign key per target, so a review cannot outlive what it is about and
-- cannot point at a row that was never there. With a generic pair, `on delete
-- cascade` is not expressible and the integrity is left to application code.
--
-- The CHECK counts non-nulls rather than enumerating the seven invalid
-- combinations. Adding a fourth reviewable thing later is then one column and
-- one more addend, not a rewritten boolean expression.
alter table public.facilitator_reviews
  alter column booking_id drop not null;

alter table public.facilitator_reviews
  add column if not exists event_registration_id uuid
    references public.event_registrations(id) on delete cascade,
  add column if not exists class_registration_id uuid
    references public.class_registrations(id) on delete cascade;

alter table public.facilitator_reviews
  drop constraint if exists facilitator_reviews_one_subject;
alter table public.facilitator_reviews
  add constraint facilitator_reviews_one_subject check (
    (booking_id is not null)::int
  + (event_registration_id is not null)::int
  + (class_registration_id is not null)::int = 1
  );

-- ---------------------------------------------------------------------------
-- One review per subject
-- ---------------------------------------------------------------------------
-- The old `unique` on booking_id came from the column definition and has to go
-- with the not-null, because a unique constraint (as opposed to a unique
-- index) would treat the now-possible nulls as distinct — which is the correct
-- SQL behaviour and useless here, since it would let a table of event reviews
-- accumulate any number of null booking_ids while claiming to be unique.
--
-- Replaced by three partial unique indexes: each says "at most one review per
-- subject" and none of them sees the rows belonging to the other two.
alter table public.facilitator_reviews
  drop constraint if exists facilitator_reviews_booking_id_key;

create unique index if not exists facilitator_reviews_booking_idx
  on public.facilitator_reviews (booking_id)
  where booking_id is not null;

create unique index if not exists facilitator_reviews_event_registration_idx
  on public.facilitator_reviews (event_registration_id)
  where event_registration_id is not null;

create unique index if not exists facilitator_reviews_class_registration_idx
  on public.facilitator_reviews (class_registration_id)
  where class_registration_id is not null;

-- ---------------------------------------------------------------------------
-- What the aggregate trigger does about all this: nothing
-- ---------------------------------------------------------------------------
-- `facilitator_id` stays a required column and 0036's trigger keys on it and
-- on `status` alone. A review of an event and a review of a session therefore
-- land on the same facilitator's average without a line of it changing.
--
-- That is the intent, not a happy accident. The rating is of the *person* —
-- someone deciding whether to book Prem is served by knowing how his workshops
-- went, and splitting the average by format would produce two thin numbers
-- where one solid one is more use.
--
-- One consequence worth naming: only an event with a `facilitator_id` (0045)
-- can be reviewed, because an event with no host has nobody to attribute a
-- rating to. Hilom's own events collect no rating. If they should collect
-- testimonials, that is a different feature — display copy for the event page,
-- not a number feeding somebody's average — and it should be built as one
-- rather than by inventing a house facilitator row to hang it on.

comment on column public.facilitator_reviews.booking_id is
  'Set when this reviews a 1:1 session. Exactly one of booking_id, '
  'event_registration_id and class_registration_id is non-null (0050).';
comment on column public.facilitator_reviews.event_registration_id is
  'Set when this reviews an event the facilitator hosted. Only events with '
  'events.facilitator_id can be reviewed — see the header of 0050.';
comment on column public.facilitator_reviews.class_registration_id is
  'Set when this reviews a group class session (0049).';

-- The moderation queue reads every pending review and now has to say what each
-- one is *about*, which means loading the subject. Indexed so that join is not
-- a sequential scan once there are a few thousand reviews.
create index if not exists facilitator_reviews_event_reg_lookup_idx
  on public.facilitator_reviews (event_registration_id)
  where event_registration_id is not null;

create index if not exists facilitator_reviews_class_reg_lookup_idx
  on public.facilitator_reviews (class_registration_id)
  where class_registration_id is not null;

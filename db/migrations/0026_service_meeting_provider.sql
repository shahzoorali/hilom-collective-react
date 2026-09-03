-- Per-service meeting provider, and per-booking meeting identity.
--
-- Until now a service carried one static `meeting_url` — a standing room the
-- facilitator typed once. This adds the choice of having Hilom create a real
-- meeting per booking in the facilitator's own connected Google or Zoom
-- account (see 0025 and docs/meeting-link-integrations.md).
--
--   meeting_provider = 'manual'      → keep using meeting_url as before
--   meeting_provider = 'google_meet' → create a Meet space at confirmation
--   meeting_provider = 'zoom'        → create a scheduled Zoom meeting
--
-- `meeting_url` stays meaningful for every value: for 'manual' it is the link;
-- for the integrated providers it is the **backup**, used only if creation
-- fails at confirmation time. That keeps the invariant the booking flow is
-- built on — a confirmed booking always has *a* way to join — without making
-- meeting creation a step that can fail the booking.

alter table public.facilitator_services
  add column if not exists meeting_provider text not null default 'manual'
    check (meeting_provider in ('manual', 'google_meet', 'zoom'));

-- On the booking, both are snapshots written at confirmation, not at insert:
-- the meeting is created only once payment has actually landed, so an
-- abandoned checkout never provisions one.
--
--   meeting_provider    — which provider actually created this booking's link
--                         (or 'manual'). Snapshotted so a later change to the
--                         service cannot rewrite how an existing session was
--                         set up.
--   meeting_external_id — the provider's own id for the meeting: a Zoom
--                         meeting id, or a Meet space resource name. Needed to
--                         update the meeting on reschedule and delete it on
--                         cancellation. Null for 'manual' and for Google (a
--                         Meet space has no lifecycle to manage — it is a
--                         permanent room with no start time).
alter table public.bookings
  add column if not exists meeting_provider text
    check (meeting_provider is null or meeting_provider in ('manual', 'google_meet', 'zoom'));

alter table public.bookings
  add column if not exists meeting_external_id text;

-- The reschedule/cancel sync path: bookings whose meeting lives in a provider
-- account and therefore has an external object to keep in step.
create index if not exists bookings_meeting_external_idx
  on public.bookings (meeting_provider)
  where meeting_external_id is not null;

-- No RLS change. `facilitator_services` has a table-level select grant to
-- anon/authenticated (0011), so the new column is already readable, and it
-- says nothing sensitive — which video tool, not any credential. The two
-- `bookings` columns are on a table that is backend-only already.

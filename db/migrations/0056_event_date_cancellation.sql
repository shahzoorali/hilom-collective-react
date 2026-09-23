-- Cancelling a single event date (0054, step 3).
--
-- A facilitator-hosted event is now built from several `events` rows under one
-- `event_series` (0055). Cancelling one date — a venue falls through, a
-- facilitator gets sick — must stop new sales on that date and refund whoever
-- already holds a seat, without touching the other dates in the series or the
-- series' own review record. Neither `events.status` (draft/published) nor
-- `remove()` in admin-events.ts does that: `status` alone cannot say *why* an
-- event is off-sale, and `remove()` refuses to delete an event with live
-- registrations at all (rightly — deleting the row would delete the record
-- that people paid).
--
-- Two columns, the minimum that lets the UI and the audit trail tell "never
-- published" apart from "was live, then pulled":
alter table public.events
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text;

comment on column public.events.cancelled_at is
  'Set when this date is called off after going on sale (0054). Distinct from '
  '`status`, which cancelling also sets to draft to stop new sales — this is '
  'what tells "cancelled" apart from "never published" on the same draft status.';
comment on column public.events.cancel_reason is
  'Shown to registrants in the cancellation email and to the host/admin on the '
  'event. Required by the handler when cancelling, not enforced here — same '
  'choice migration 0048 makes for review_note.';

-- The admin/facilitator "cancelled dates" filter.
create index if not exists events_cancelled_idx
  on public.events (cancelled_at)
  where cancelled_at is not null;

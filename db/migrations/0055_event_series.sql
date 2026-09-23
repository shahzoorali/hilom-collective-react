-- Multi-date facilitator events: one proposal, several dates, one review.
--
-- ===========================================================================
-- Why a series and not just more events
-- ===========================================================================
-- 0048 let a facilitator propose a single `events` row. Prem's Mon/Wed/Fri
-- programme showed the gap: three dates for one idea means three separate
-- proposals, three separate admin reviews, and three separate approval emails
-- for what is, to everyone involved, one decision — "should Prem run this".
--
-- `event_series` is that one decision. Each date stays a normal `events` row —
-- seat claiming (0016), PayMongo checkout, fulfillment, the roster, cancelling
-- a single date — none of it changes or needs to know a series exists. The
-- series is a thin row above them that the facilitator submits once and an
-- admin reviews once, and whose approval cascades price, capacity and the
-- revenue share down onto every date at the same moment.
--
-- ===========================================================================
-- Why price and capacity live here, not on the events yet
-- ===========================================================================
-- 0048's proposal fields (title, dates, description — DRAFT_FIELDS in
-- facilitator-portal.ts) deliberately exclude anything about money: capacity,
-- ticketing and price are the admin's to set, per the comment on DRAFT_FIELDS.
-- A series proposal keeps that line. `proposed_price_centavos` and
-- `proposed_capacity` are the facilitator's *ask*, shown to the admin as a
-- starting point in the review screen — not yet a plan or a capacity on any
-- event. Approval is what turns the ask into ticketing: a payment plan is
-- written onto every date event and its `capacity`/`ticketing_enabled` are set,
-- using the admin's numbers, which may or may not be what was asked for.
create table if not exists public.event_series (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,

  -- For the admin queue and the facilitator's "my series" list. Not kept in
  -- sync with the child events' own titles — Day 1 and Day 2 of a programme
  -- may legitimately be titled differently — this is only ever the series'
  -- own label.
  title text not null,

  review_status public.event_review_status not null default 'draft',
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  review_note   text,

  proposed_price_centavos int check (proposed_price_centavos >= 0),
  proposed_capacity       int check (proposed_capacity > 0),

  -- Set by the admin at approval, same column and meaning as events.platform_fee_bps
  -- (0054) — this is where it is decided; approval copies it onto every date.
  platform_fee_bps int check (platform_fee_bps between 0 and 10000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.event_series is
  'Groups the dates of one facilitator-proposed programme (0054) under one '
  'review. Each date is still a normal events row; see events.series_id.';
comment on column public.event_series.proposed_price_centavos is
  'What the facilitator asked to charge per date. A starting point for the '
  'admin review, not a price anyone has been charged — see events_payment_plans, '
  'written at approval.';

drop trigger if exists event_series_set_updated_at on public.event_series;
create trigger event_series_set_updated_at
  before update on public.event_series
  for each row execute function public.set_updated_at();

-- The admin moderation queue, same shape as 0048's events_review_queue_idx.
create index if not exists event_series_review_queue_idx
  on public.event_series (review_status, submitted_at)
  where review_status in ('submitted', 'rejected');

-- "My series", on the facilitator portal.
create index if not exists event_series_facilitator_idx
  on public.event_series (facilitator_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Linking a date to its series
-- ---------------------------------------------------------------------------
-- Nullable, and ON DELETE SET NULL: a single-date proposal has no series to
-- speak of under the facilitator flow (it is still just an events row), and an
-- admin-authored event was never part of one. Deleting a series must not take
-- its dates down with it — voiding the *grouping* is not the same decision as
-- cancelling a date somebody may already hold a seat for.
alter table public.events
  add column if not exists series_id uuid
    references public.event_series(id) on delete set null;

comment on column public.events.series_id is
  'The event_series (0054) this date belongs to, if it was proposed as part '
  'of a multi-date programme. Null for a single-date proposal or an event an '
  'admin created directly.';

create index if not exists events_series_idx
  on public.events (series_id)
  where series_id is not null;

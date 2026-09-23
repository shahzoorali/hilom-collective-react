-- A waitlist for a sold-out event date (0054, Phase 2).
--
-- ===========================================================================
-- What this is, and what it deliberately is not
-- ===========================================================================
-- This is a "tell me when a seat opens up" list, not a held reservation. When
-- a seat frees up, the sweep emails the oldest waiting people a registration
-- link before anyone else hears about it — but registering is still the
-- ordinary first-come, first-served `claim_event_seat` flow everyone else
-- goes through. Nothing here reserves a seat number for a specific person.
--
-- A true priority hold — one seat set aside with someone's name on it until
-- they claim it or a deadline passes — is a real seat-numbering change to
-- `claim_event_seat` (0016) and its exclusion index, not a column on a new
-- table. That is the honest next step if lead time turns out to matter more
-- than it looks like it will; building it speculatively now would be
-- guessing at a UX nobody has asked for yet.
do $$ begin
  create type public.waitlist_status as enum ('waiting', 'notified', 'converted');
exception when duplicate_object then null;
end $$;

create table if not exists public.event_waitlist (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  -- The buyer, identified the same way a registration is (0016): the
  -- verified Cognito email, with `sub` kept alongside because an email can
  -- change. No separate "registrant" here — unlike a registration, a
  -- waitlist entry is not yet a place someone is holding for anyone.
  email text not null,
  name  text not null,
  phone text,

  status public.waitlist_status not null default 'waiting',

  joined_at   timestamptz not null default now(),
  -- When the sweep told them a seat was open. Once set, this row is never
  -- re-notified — a second opening goes to the next `waiting` entry instead.
  -- Simpler than re-queuing a lapsed notification, and the honest behaviour
  -- for something that is a courtesy heads-up rather than a held place.
  notified_at timestamptz,

  created_at timestamptz not null default now()
);

comment on table public.event_waitlist is
  'A "tell me when a seat opens up" list for a sold-out event date. Not a '
  'reservation — see the header note in 0060 for why a held seat is a '
  'different, larger feature than this.';
comment on column public.event_waitlist.status is
  'waiting: has not been told a seat is open. notified: was told once, and '
  'can register like anyone else while seats last — never re-notified. '
  'converted: they registered, set by register() when it finds a waiting or '
  'notified row for the same event and email.';

-- One live waitlist entry per person per event. Partial on `waiting` so
-- someone who was notified, did not convert, and is later re-added is not
-- blocked by their own expired history.
create unique index if not exists event_waitlist_unique_waiting
  on public.event_waitlist (event_id, lower(email))
  where status = 'waiting';

-- The sweep's scan, and the roster screen's list.
create index if not exists event_waitlist_event_status_idx
  on public.event_waitlist (event_id, status, joined_at);

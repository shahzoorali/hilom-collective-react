-- A default event commission per facilitator (0054, Phase 3).
--
-- `event_series.platform_fee_bps` and `events.platform_fee_bps` (0054, 0055)
-- are deliberately set per event rather than inherited from
-- `facilitators.platform_fee_bps` — that column governs sessions and classes,
-- and an event is negotiated per booking rather than automatic (see the
-- comment on `event_series.platform_fee_bps`). That is still right: nothing
-- here changes it.
--
-- What was missing is a *starting point*. An admin who runs the same
-- commission on every event for a given facilitator had to remember and
-- retype it on every single approval, with no record of what "the usual
-- rate" even was between reviews. This is that memory, and nothing else —
-- it pre-fills the review drawer's commission field and is never read by
-- anything that pays anyone.
alter table public.facilitators
  add column if not exists default_event_platform_fee_bps int
    check (default_event_platform_fee_bps between 0 and 10000);

comment on column public.facilitators.default_event_platform_fee_bps is
  'Pre-fills the commission field when reviewing this facilitator''s event or '
  'series proposals — a starting point for the admin, not a rate anything is '
  'ever paid against. Null shows no default, same as before this column '
  'existed. Compare facilitators.platform_fee_bps, which governs sessions and '
  'classes directly and this column never touches.';

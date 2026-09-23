-- Editing an approved, published event (0054, Phase 2).
--
-- Until now `saveProposal` in facilitator-portal.ts froze every content field
-- the moment an event was approved — see the comment on DRAFT_FIELDS, "the
-- title and date of a published event are what attendees bought" — and the
-- facilitator UI did not even offer an Edit button once approved. That is
-- right for the fields it is right for, and too blunt for the rest: a
-- facilitator fixing a typo in the description or swapping the poster image
-- should not need Hilom's permission, and one changing the venue or the date
-- absolutely should, without the event vanishing from the site while that
-- gets decided.
--
-- ---------------------------------------------------------------------------
-- Two lanes, not one
-- ---------------------------------------------------------------------------
-- `review_status` (0048) already answers "may this be published" for the
-- *original* proposal, and 0048's own check constraint ties it to `status`.
-- Reusing it for a post-publish edit would mean either violating that
-- constraint (setting review_status back to 'submitted' while status stays
-- 'published' is exactly what it forbids) or unpublishing a live, sold event
-- just because someone asked to correct its venue.
--
-- So an edit gets its own, independent lane. `review_status` keeps meaning
-- "was this ever approved to publish"; these columns mean "is a change to it
-- currently waiting on a decision" — and the two can be true at once.
alter table public.events
  -- Only the material fields that changed, as {field: newValue}. Cosmetic
  -- fields (subtitle, excerpt, description, image, venue_details) are never
  -- staged here — they are written straight onto the row, which is what makes
  -- them not need a review lane at all.
  add column if not exists pending_changes jsonb,
  add column if not exists edit_submitted_at timestamptz,
  add column if not exists edit_reviewed_at  timestamptz,
  -- Shown back to the facilitator verbatim, same rule 0048's review_note
  -- follows and for the same reason: a decline with no reason is a support
  -- thread every time.
  add column if not exists edit_review_note  text;

comment on column public.events.pending_changes is
  'Proposed new values for title/starts_at/ends_at/location/format, staged '
  'while an admin decides — the live event keeps its current values until '
  'approval copies these on top of them. Null when nothing is pending.';
comment on column public.events.edit_submitted_at is
  'When a material edit was last proposed. A pending edit is '
  '`pending_changes is not null and edit_reviewed_at is null` — reviewing it '
  'clears pending_changes but keeps this and edit_reviewed_at as the record '
  'of the decision, the same way review_note (0048) survives a rejection.';

-- The admin queue: edits waiting on a decision.
create index if not exists events_edit_review_queue_idx
  on public.events (edit_submitted_at)
  where pending_changes is not null and edit_reviewed_at is null;

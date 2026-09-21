-- Let a facilitator propose an event, and make a Hilom admin the one who
-- publishes it.
--
-- Until now every row in `events` was written by an admin through the admin
-- screen, so "exists" and "approved" were the same fact and `status`
-- (draft/published) carried both. A facilitator-authored row breaks that: it
-- exists from the moment they start typing, and it must not be publishable by
-- the person who wrote it.
--
-- ---------------------------------------------------------------------------
-- Why a second column and not two more values on `page_status`
-- ---------------------------------------------------------------------------
-- `events.status` is `public.page_status` (0006), shared with `pages` and
-- `posts`. Adding 'submitted' and 'rejected' to that enum would put event
-- moderation into the vocabulary of the page editor and the blog, where the
-- values are unreachable and meaningless, and every `status` switch in the CMS
-- would gain two dead branches. Worse, the two axes are genuinely independent:
-- an approved event can still be unpublished by an admin later, which is a
-- `status` change that must not read as un-approving it.
--
-- So moderation gets its own column, and the two answer different questions:
--
--   review_status  — may this be published, and who decided
--   status         — is it published
--
-- ---------------------------------------------------------------------------
-- Why the default is 'approved'
-- ---------------------------------------------------------------------------
-- Every row that exists when this migration runs was created by an admin. A
-- default of 'draft' would retroactively mark the entire live events page as
-- un-reviewed, and any publish guard written against this column would then
-- refuse to republish an event that has been running for months. New rows from
-- the facilitator portal set 'draft' explicitly; the admin screen keeps
-- writing 'approved', because an admin creating an event *is* the approval.
create type public.event_review_status as enum
  ('draft', 'submitted', 'approved', 'rejected');

alter table public.events
  add column if not exists review_status public.event_review_status
    not null default 'approved',
  -- Who proposed it. Distinct from `facilitator_id` (0045), which is who is
  -- *hosting* it: an admin may well approve a submission and then assign a
  -- second facilitator to run it, and an event created by an admin on a
  -- facilitator's behalf has a host and no submitter at all.
  add column if not exists submitted_by uuid
    references public.facilitators(id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at  timestamptz,
  -- Shown back to the facilitator verbatim. A rejection with no reason
  -- produces a support email every single time.
  add column if not exists review_note  text;

comment on column public.events.review_status is
  'Moderation state, independent of `status`. Only an admin may move a row to '
  'approved or rejected, and nothing may be published unless this is approved. '
  'Defaults to approved because every pre-0048 row was admin-authored.';
comment on column public.events.submitted_by is
  'The facilitator who proposed this event. Distinct from facilitator_id (0045), '
  'which is who hosts it — an admin may reassign the host on approval.';

-- ---------------------------------------------------------------------------
-- Invisibility is inherited, not re-implemented
-- ---------------------------------------------------------------------------
-- The public read policy from 0007 is already `using (status = 'published')`.
-- A submitted event carries `status = 'draft'`, so it is unreachable by anon
-- and authenticated readers through RLS that already exists — no new policy,
-- and no second place that has to be kept correct.
--
-- What that policy cannot do is stop the *backend* publishing an unapproved
-- row, because the service role bypasses RLS entirely. That guard has to be a
-- constraint, or it is a line of handler code that one future endpoint forgets.
alter table public.events
  drop constraint if exists events_publish_requires_approval;
alter table public.events
  add constraint events_publish_requires_approval
    check (status <> 'published' or review_status = 'approved');

-- The admin moderation queue: everything awaiting a decision, oldest first,
-- because a submission that has been waiting three days matters more than one
-- from this morning. Partial, because approved rows are the overwhelming
-- majority and never appear in this query.
create index if not exists events_review_queue_idx
  on public.events (review_status, submitted_at)
  where review_status in ('submitted', 'rejected');

-- "My submissions", on the facilitator portal.
create index if not exists events_submitted_by_idx
  on public.events (submitted_by, submitted_at desc)
  where submitted_by is not null;

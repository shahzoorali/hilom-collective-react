-- Trash (soft delete), duplicate, and scheduled publish for pages and posts.
--
-- Design notes:
--  * `page_status` (0006_cms.sql) already carries pages/posts/events. Adding
--    'scheduled' and 'trash' as two more values of that same enum keeps every
--    existing `status = 'published'` filter correct with zero changes: a
--    scheduled or trashed row is simply not 'published', so it already stops
--    appearing anywhere that matters without touching a single query.
--  * Trashing does NOT touch the `status` a row had — it moves it sideways
--    into `previous_status` and sets `status = 'trash'`, so "Restore" can put
--    a published post back to published and a draft back to draft, rather
--    than every restored item landing in draft regardless of what it was.
--  * `deleted_at` is redundant with `status = 'trash'` for filtering, but is
--    kept as its own column because "when was this trashed" is exactly what
--    a trash view sorts and displays by, and recovering that from `updated_at`
--    would be a coincidence, not a fact.
--  * Duplicate needs no new column: it is just another `insert` in the admin
--    handler, entirely inside the app already.
--  * Scheduled publish is a status, not a flag layered onto 'draft', because
--    a scheduled item must be excluded from anything that filters on
--    `status = 'draft'` (e.g. a future "drafts" tab) the same way it is
--    already excluded from `status = 'published'`.

-- New enum values. Values are additive to every existing row (untouched,
-- still 'draft' or 'published') and to every table that shares this enum
-- (events included) — nothing here changes what any of them mean today.
alter type public.page_status add value if not exists 'scheduled';
alter type public.page_status add value if not exists 'trash';

alter table public.pages
  add column if not exists deleted_at      timestamptz,
  add column if not exists previous_status public.page_status,
  add column if not exists scheduled_at    timestamptz;

alter table public.posts
  add column if not exists deleted_at      timestamptz,
  add column if not exists previous_status public.page_status,
  add column if not exists scheduled_at    timestamptz;

comment on column public.pages.deleted_at is
  'Set when moved to trash, cleared on restore. Sort/display key for the trash view.';
comment on column public.pages.previous_status is
  'Status to return to on restore (draft or published) — trashing must not lose whether a page was live.';
comment on column public.pages.scheduled_at is
  'When status = scheduled, the time the scheduled-publish sweep should actually publish this row.';

comment on column public.posts.deleted_at is
  'Set when moved to trash, cleared on restore. Sort/display key for the trash view.';
comment on column public.posts.previous_status is
  'Status to return to on restore (draft or published) — trashing must not lose whether a post was live.';
comment on column public.posts.scheduled_at is
  'When status = scheduled, the time the scheduled-publish sweep should actually publish this row.';

-- Trash view: "everything trashed, newest-trashed first".
create index if not exists pages_deleted_at_idx on public.pages(deleted_at) where deleted_at is not null;
create index if not exists posts_deleted_at_idx on public.posts(deleted_at) where deleted_at is not null;

-- Scheduled-publish sweep: "everything due", polled every few minutes.
create index if not exists pages_scheduled_at_idx on public.pages(scheduled_at) where status = 'scheduled';
create index if not exists posts_scheduled_at_idx on public.posts(scheduled_at) where status = 'scheduled';

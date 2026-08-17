-- Blog: categories, posts, and post revisions.
--
-- Design notes:
--  * Categories are a simple lookup table with a position for ordering.
--    Every post has at most one category (FK, nullable); tags are many.
--  * Tags are stored as text[] with a GIN index rather than a join table.
--    Tags here are flat labels with no attributes of their own; a join table
--    would add two queries and a migration for something
--    `where tags @> ARRAY['rest']` answers directly.
--  * Draft and published content are separate JSONB columns, exactly like
--    pages (0006_cms.sql) — the whole point of choosing Puck for the body
--    is that posts reuse that machinery unchanged.
--  * Reuses public.page_status (draft/published) from 0006_cms.sql — same
--    semantics as pages and events, no separate enum needed.

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists categories_position_idx on public.categories(position);

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  title            text not null,
  excerpt          text,
  -- Cover image: same {id, url, alt} trio as events, with a FK to
  -- media_assets so deleting the image clears the reference.
  image_id         uuid references public.media_assets(id) on delete set null,
  image_url        text,
  image_alt        text,
  -- Simple text byline, not a users table FK — there may never be more than
  -- a handful of authors and none of them need login accounts.
  author_name      text,
  author_image_url text,
  category_id      uuid references public.categories(id) on delete set null,
  tags             text[] not null default '{}',
  seo_title        text,
  seo_description  text,
  status           public.page_status not null default 'draft',
  published_at     timestamptz,
  published_blocks jsonb not null default '[]'::jsonb,
  draft_blocks     jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on column public.posts.published_blocks is
  'What visitors see. Only ever written by the publish endpoint.';
comment on column public.posts.tags is
  'Flat label set — filtered with @> (GIN), no join table needed.';

-- The public list is always "published, newest first".
create index if not exists posts_status_published_at_idx
  on public.posts(status, published_at desc);

-- Tag queries: WHERE tags @> ARRAY['rest'] uses GIN.
create index if not exists posts_tags_gin_idx
  on public.posts using gin(tags);

-- Category filter on the public list.
create index if not exists posts_category_id_idx
  on public.posts(category_id);

drop trigger if exists posts_set_updated_at on public.posts;
create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- post_revisions — same shape as page_revisions
-- ---------------------------------------------------------------------------
create table if not exists public.post_revisions (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts(id) on delete cascade,
  blocks     jsonb not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists post_revisions_post_id_created_idx
  on public.post_revisions(post_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — same shape as pages/events: anon reads published rows only; the
-- backend (service_role) has full access via the secret key, which bypasses
-- RLS but still needs explicit grants (see the note in 0002_rls.sql).
-- ---------------------------------------------------------------------------
alter table public.categories      enable row level security;
alter table public.posts            enable row level security;
alter table public.post_revisions   enable row level security;

-- Categories are always public (they're just labels).
grant select on public.categories to anon, authenticated;

drop policy if exists categories_public_read on public.categories;
create policy categories_public_read
  on public.categories for select
  to anon, authenticated
  using (true);

-- Posts: anon sees published only.
grant select on public.posts to anon, authenticated;

drop policy if exists posts_public_read on public.posts;
create policy posts_public_read
  on public.posts for select
  to anon, authenticated
  using (status = 'published');

-- Revisions: no anon/authenticated access at all.
revoke all on public.post_revisions from anon, authenticated;

-- service_role needs explicit privileges for all three tables.
grant select, insert, update, delete on public.categories to service_role;
grant select, insert, update, delete on public.posts to service_role;
grant select, insert, update, delete on public.post_revisions to service_role;
grant usage, select on all sequences in schema public to service_role;

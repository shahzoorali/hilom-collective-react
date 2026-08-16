-- CMS: pages, menus, media, forms.
--
-- Design notes:
--  * A page's blocks are a JSONB array, not a `page_blocks` table. Blocks are
--    always read and written as one ordered list for one page and are never
--    queried across pages, so a child table would buy nothing and would make
--    reordering a multi-row rewrite. As JSONB, a reorder is one atomic update
--    and draft-vs-published is a second column rather than a duplicated row set.
--    Block shapes are validated in TypeScript at the API boundary
--    (backend/src/lib/cms-blocks.ts).
--  * Draft and published content are separate columns on the same row. Editing
--    a live page can therefore never change what visitors see until publish.
--  * `is_system` marks pages that have code depending on their slug existing
--    (the nav links to them). They are editable but not deletable.
--  * The `forms` tables are for NEW forms an admin creates. The community
--    signup form is not migrated into them: it already works, relaying to
--    kumusta@hilomcollective.com via SES (backend/src/handlers/community.ts),
--    and rebuilding a working email path on top of a generic form engine would
--    be a downgrade. The CMS makes the copy around that form editable instead.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- pages
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.page_status as enum ('draft', 'published');
exception when duplicate_object then null;
end $$;

create table if not exists public.pages (
  id               uuid primary key default gen_random_uuid(),
  -- Path without the leading slash, e.g. 'about'. The home page uses the
  -- reserved slug 'home' rather than an empty string, so that `/pages/{slug}`
  -- stays a single API route shape.
  slug             text not null unique,
  title            text not null,
  status           public.page_status not null default 'draft',
  published_blocks jsonb not null default '[]'::jsonb,
  draft_blocks     jsonb not null default '[]'::jsonb,
  seo_title        text,
  seo_description  text,
  is_system        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  published_at     timestamptz
);

comment on column public.pages.published_blocks is
  'What visitors see. Only ever written by the publish endpoint.';
comment on column public.pages.is_system is
  'Slug is referenced from code (nav, CTAs). Editable, never deletable.';

-- The public read path is always "one page by slug, if published".
create index if not exists pages_status_slug_idx on public.pages(status, slug);

-- ---------------------------------------------------------------------------
-- page_revisions — a publish history, so a bad edit is recoverable
-- ---------------------------------------------------------------------------
create table if not exists public.page_revisions (
  id         uuid primary key default gen_random_uuid(),
  page_id    uuid not null references public.pages(id) on delete cascade,
  blocks     jsonb not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists page_revisions_page_id_created_idx
  on public.page_revisions(page_id, created_at desc);

-- ---------------------------------------------------------------------------
-- menus
-- ---------------------------------------------------------------------------
create table if not exists public.menus (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,   -- 'header' | 'footer'
  label      text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.menu_items (
  id         uuid primary key default gen_random_uuid(),
  menu_id    uuid not null references public.menus(id) on delete cascade,
  -- One level of nesting only; the UI does not offer deeper trees.
  parent_id  uuid references public.menu_items(id) on delete cascade,
  position   integer not null default 0,
  label      text not null,
  href       text not null,
  target     text not null default 'self' check (target in ('self', 'blank')),
  visible    boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists menu_items_menu_position_idx
  on public.menu_items(menu_id, position);

-- ---------------------------------------------------------------------------
-- media_assets — S3 objects served through CloudFront
-- ---------------------------------------------------------------------------
create table if not exists public.media_assets (
  id           uuid primary key default gen_random_uuid(),
  -- S3 object key. `url` is stored rather than derived so that moving to a
  -- custom CDN domain later is a data migration, not a code change.
  key          text not null unique,
  url          text not null,
  filename     text not null,
  content_type text not null,
  bytes        integer,
  width        integer,
  height       integer,
  alt          text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- forms + submissions (for admin-created forms; see the note at the top)
-- ---------------------------------------------------------------------------
create table if not exists public.forms (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  -- Ordered field definitions; see FormField in backend/src/lib/cms-blocks.ts.
  fields          jsonb not null default '[]'::jsonb,
  submit_label    text not null default 'Submit',
  success_message text not null default 'Thanks for reaching out — we''ll be in touch soon.',
  -- Reserved for an SES notification path like community.ts already has.
  notify_email    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.form_submissions (
  id         uuid primary key default gen_random_uuid(),
  form_id    uuid not null references public.forms(id) on delete cascade,
  data       jsonb not null,
  -- Hashed, never the raw address: rate limiting only needs equality, and a
  -- submissions table holding names, emails, and IPs is a bigger breach than
  -- one that doesn't.
  ip_hash    text,
  user_agent text,
  -- Honeypot hits are stored and flagged rather than rejected, so a false
  -- positive is recoverable instead of a silently lost enquiry.
  is_spam    boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists form_submissions_form_created_idx
  on public.form_submissions(form_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuses public.set_updated_at from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists pages_set_updated_at on public.pages;
create trigger pages_set_updated_at
  before update on public.pages
  for each row execute function public.set_updated_at();

drop trigger if exists forms_set_updated_at on public.forms;
create trigger forms_set_updated_at
  before update on public.forms
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — same threat model as 0002_rls.sql: the publishable key is public, so
-- `anon` gets read access to published content only, and no access at all to
-- submissions (they hold names, emails, and free-text messages).
-- ---------------------------------------------------------------------------
alter table public.pages            enable row level security;
alter table public.page_revisions   enable row level security;
alter table public.menus            enable row level security;
alter table public.menu_items       enable row level security;
alter table public.media_assets     enable row level security;
alter table public.forms            enable row level security;
alter table public.form_submissions enable row level security;

grant select on public.pages, public.menus, public.menu_items, public.media_assets, public.forms
  to anon, authenticated;

drop policy if exists pages_public_read on public.pages;
create policy pages_public_read
  on public.pages for select
  to anon, authenticated
  using (status = 'published');

drop policy if exists menus_public_read on public.menus;
create policy menus_public_read
  on public.menus for select to anon, authenticated using (true);

drop policy if exists menu_items_public_read on public.menu_items;
create policy menu_items_public_read
  on public.menu_items for select to anon, authenticated using (visible);

drop policy if exists media_assets_public_read on public.media_assets;
create policy media_assets_public_read
  on public.media_assets for select to anon, authenticated using (true);

-- Field definitions are public (the form renders from them); submissions are not.
drop policy if exists forms_public_read on public.forms;
create policy forms_public_read
  on public.forms for select to anon, authenticated using (true);

-- Revisions and submissions: RLS on with no policy denies every row, and the
-- grants are revoked too, so a later permissive policy added by mistake still
-- would not expose them.
revoke all on public.page_revisions, public.form_submissions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- service_role (the backend secret key) needs explicit privileges; bypassing
-- RLS is not the same as having them. See the note in 0002_rls.sql.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.pages, public.page_revisions, public.menus, public.menu_items,
  public.media_assets, public.forms, public.form_submissions
  to service_role;
grant usage, select on all sequences in schema public to service_role;

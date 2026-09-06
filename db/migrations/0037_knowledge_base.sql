-- Knowledge base: categories, articles, and article revisions.
--
-- Design notes:
--  * Article bodies are **markdown text**, not Puck block JSONB like pages
--    (0006), posts (0008) and events (0007). Deliberate divergence: a help
--    article is a linear document, not a composed layout, and the block tree
--    costs three things a KB needs. A heading TOC would mean walking block
--    JSON; full-text search would mean an extraction function to get prose out
--    of JSONB; and authoring ~50 troubleshooting articles by composing blocks
--    is materially slower than typing. The trade accepted here is that a KB
--    article cannot embed a marketing block (card grid, stat strip) — if that
--    is ever wanted, this column becomes `published_blocks` and the TOC and
--    search grow an extraction step.
--  * `search_tsv` is a *generated* column rather than a trigger-maintained one,
--    so the index physically cannot drift from the body it indexes. Postgres
--    FTS is the whole search implementation: at this corpus size an external
--    search service is infrastructure with no corresponding benefit.
--  * Reuses public.page_status (draft/published) from 0006_cms.sql and the
--    public.set_updated_at() trigger function — same publish semantics as
--    every other content type, no new enum for it.
--  * There is no `helpful_no` counter. A bare thumbs-down records that an
--    article failed without recording why, which is a number nobody can act
--    on; the negative path is a "Still stuck? Contact support" link instead,
--    so the same signal arrives as a support ticket that carries context.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------

-- Drives the grouped subheading on a category page ("Troubleshooting" sits
-- below the guides). Stored rather than inferred from the slug so the grouping
-- survives an article being retitled.
do $$ begin
  create type public.kb_article_kind as enum ('guide', 'troubleshooting');
exception when duplicate_object then null;
end $$;

-- Client and facilitator help live in one navigation tree, so an article has
-- to say who it is for. Without this a client searching "payouts" is handed
-- facilitator articles describing a screen they cannot open.
do $$ begin
  create type public.kb_audience as enum ('client', 'facilitator', 'both');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- kb_categories — the top-level sections
-- ---------------------------------------------------------------------------
create table if not exists public.kb_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  -- An icon *key* resolved by the frontend, not a media_assets FK. These are
  -- eight fixed glyphs shipped with the build, not uploaded artwork.
  icon        text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists kb_categories_position_idx
  on public.kb_categories(position);

drop trigger if exists kb_categories_set_updated_at on public.kb_categories;
create trigger kb_categories_set_updated_at
  before update on public.kb_categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- kb_articles
-- ---------------------------------------------------------------------------
create table if not exists public.kb_articles (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  -- `restrict`, not `set null`: an article with no category is unreachable
  -- from the navigation but still live and indexed by search engines. Deleting
  -- a category that still holds articles should fail loudly and force them to
  -- be moved.
  category_id     uuid not null references public.kb_categories(id) on delete restrict,
  title           text not null,
  -- The one-line under the title in category listings, and the fallback meta
  -- description. Most KB traffic arrives from a search engine straight onto an
  -- article, so this line is doing more work than the hub page is.
  summary         text,
  body            text not null default '',
  kind            public.kb_article_kind not null default 'guide',
  audience        public.kb_audience not null default 'client',
  position        integer not null default 0,
  -- Flat labels, same call as posts.tags (0008): filtered with @> over GIN,
  -- no join table. Related-article suggestions are derived from these plus
  -- the shared category rather than from a curated list, so no editor has to
  -- maintain cross-links across fifty articles by hand.
  tags            text[] not null default '{}',
  seo_title       text,
  seo_description text,
  status          public.page_status not null default 'draft',
  published_at    timestamptz,
  -- Positive signal only; see the note at the top of this file.
  helpful_yes     integer not null default 0,
  search_tsv      tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(title, '')),   'A') ||
                    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce(body, '')),    'C')
                  ) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.kb_articles.body is
  'Markdown. Rendered to HTML at read time — see the note at the top of 0037.';
comment on column public.kb_articles.search_tsv is
  'Generated, never written directly. Title matches outrank body mentions.';
comment on column public.kb_articles.audience is
  'Who the article is for. Client and facilitator help share one nav tree.';

-- Search.
create index if not exists kb_articles_search_idx
  on public.kb_articles using gin(search_tsv);

-- A category page is always "this category, in author order".
create index if not exists kb_articles_category_position_idx
  on public.kb_articles(category_id, position);

-- The public list is always "published".
create index if not exists kb_articles_status_published_at_idx
  on public.kb_articles(status, published_at desc);

-- Related-article lookup: WHERE tags && ARRAY[...] uses GIN.
create index if not exists kb_articles_tags_gin_idx
  on public.kb_articles using gin(tags);

drop trigger if exists kb_articles_set_updated_at on public.kb_articles;
create trigger kb_articles_set_updated_at
  before update on public.kb_articles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- kb_article_revisions — same shape as post_revisions (0008)
-- ---------------------------------------------------------------------------
create table if not exists public.kb_article_revisions (
  id         uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.kb_articles(id) on delete cascade,
  body       text not null,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists kb_article_revisions_article_id_created_idx
  on public.kb_article_revisions(article_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — same shape as pages/posts/events: anon reads published rows only; the
-- backend (service_role) has full access via the secret key, which bypasses
-- RLS but still needs explicit grants (see the note in 0002_rls.sql).
-- ---------------------------------------------------------------------------
alter table public.kb_categories        enable row level security;
alter table public.kb_articles          enable row level security;
alter table public.kb_article_revisions enable row level security;

-- Categories are always public (they're just labels).
grant select on public.kb_categories to anon, authenticated;

drop policy if exists kb_categories_public_read on public.kb_categories;
create policy kb_categories_public_read
  on public.kb_categories for select
  to anon, authenticated
  using (true);

-- Articles: anon sees published only. Note that `audience` deliberately does
-- *not* gate reads — facilitator help is public documentation, not privileged
-- material, and a prospective facilitator reading how payouts work before
-- applying is a good outcome. It filters and ranks in the UI, nothing more.
grant select on public.kb_articles to anon, authenticated;

drop policy if exists kb_articles_public_read on public.kb_articles;
create policy kb_articles_public_read
  on public.kb_articles for select
  to anon, authenticated
  using (status = 'published');

-- Revisions: no anon/authenticated access at all.
revoke all on public.kb_article_revisions from anon, authenticated;

-- service_role needs explicit privileges for all three tables.
grant select, insert, update, delete on public.kb_categories        to service_role;
grant select, insert, update, delete on public.kb_articles          to service_role;
grant select, insert, update, delete on public.kb_article_revisions to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Seed: the eight sections, in navigation order. Articles are authored in the
-- admin, but the categories are structural — the navigation is meaningless
-- until they exist, and they are referenced by slug from the frontend routes.
-- ---------------------------------------------------------------------------
insert into public.kb_categories (slug, name, description, icon, position) values
  ('getting-started',   'Getting Started',    'Your account, and how Hilom fits together.',              'compass',  10),
  ('courses',           'Courses',            'Buying courses and getting into Hilom LMS.',              'book',     20),
  ('sessions',          'Sessions & Booking', 'Booking, rescheduling, and joining your sessions.',       'calendar', 30),
  ('events',            'Events',             'Registering for live events.',                            'ticket',   40),
  ('payments',          'Payments & Refunds', 'How you pay, where receipts live, and how refunds work.', 'card',     50),
  ('for-facilitators',  'For Facilitators',   'Running your practice on Hilom.',                          'leaf',     60),
  ('account',           'Account & Privacy',  'Your details, sign-in, and your data.',                    'user',     70),
  ('help',              'Getting Help',       'Reaching support, and what to send us.',                   'lifebuoy', 80)
on conflict (slug) do nothing;

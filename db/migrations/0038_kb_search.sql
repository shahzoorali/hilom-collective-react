-- Knowledge base search: a ranked search function.
--
-- Separate from 0037 rather than folded into it because migrations here are
-- append-only — 0037 may already be applied, and editing an applied migration
-- means the file and the database disagree for anyone who ran it.
--
-- Why a function at all. PostgREST can *filter* on a tsvector (`.textSearch()`)
-- but it cannot order by `ts_rank`, because the rank is not a column — it is a
-- function of the row and the query. Ranking in the Lambda instead would mean
-- fetching every match to sort it, which defeats the index. So the ranking, the
-- snippet and the limit all happen in one round trip here, and the handler just
-- calls `supabase.rpc('kb_search', ...)`.
--
-- SECURITY: this is SECURITY INVOKER (the default), but the backend calls it
-- with the service_role key, which bypasses RLS. The `status = 'published'`
-- predicate below is therefore doing real work — it is the *only* thing keeping
-- unpublished drafts out of public search results. Do not remove it on the
-- grounds that RLS already covers it; for this caller, RLS does not.

-- Highlight sentinels are deliberately NOT html tags. ts_headline splices its
-- markers into article prose, and returning `<mark>` would mean the frontend
-- had to render a database string as HTML to show the highlight — putting
-- article body text onto an innerHTML path. With inert sentinels the frontend
-- escapes the whole snippet first and only then swaps these for <mark>, so no
-- content can reach the DOM as markup.
create or replace function public.kb_search(
  q             text,
  audience_filter text default null,
  result_limit  integer default 20
)
returns table (
  id            uuid,
  slug          text,
  title         text,
  summary       text,
  category_slug text,
  category_name text,
  kind          public.kb_article_kind,
  audience      public.kb_audience,
  headline      text,
  rank          real
)
language sql
stable
-- Empty search_path, same discipline as public.set_updated_at() in 0001: this
-- runs with the caller's privileges and must not resolve an unqualified name
-- to something an attacker put earlier on the path. Everything below is
-- schema-qualified, the text search config included.
set search_path = ''
as $$
  select
    a.id,
    a.slug,
    a.title,
    a.summary,
    c.slug,
    c.name,
    a.kind,
    a.audience,
    pg_catalog.ts_headline(
      'pg_catalog.english'::pg_catalog.regconfig,
      -- Snippet from the body, falling back to the summary for a stub article.
      -- The body is where a match usually is; the summary is already shown in
      -- full beside the title, so highlighting it twice tells the reader nothing.
      coalesce(nullif(a.body, ''), coalesce(a.summary, '')),
      pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, q),
      'StartSel=[[hl]], StopSel=[[/hl]], MaxWords=32, MinWords=12, MaxFragments=1, FragmentDelimiter=" … "'
    ),
    pg_catalog.ts_rank(
      a.search_tsv,
      pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, q)
    )
  from public.kb_articles a
  join public.kb_categories c on c.id = a.category_id
  where a.status = 'published'
    and a.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, q)
    -- `audience_filter` narrows, it never hides: an article marked 'both'
    -- answers a client's question and a facilitator's alike, so it survives
    -- either filter. Null means "no filter" — the signed-out case.
    and (
      audience_filter is null
      or a.audience::text = audience_filter
      or a.audience = 'both'
    )
  order by
    pg_catalog.ts_rank(
      a.search_tsv,
      pg_catalog.websearch_to_tsquery('pg_catalog.english'::pg_catalog.regconfig, q)
    ) desc,
    -- Stable tiebreak. Without it two equally-ranked articles can swap places
    -- between identical queries, which reads as the page being broken.
    a.position asc,
    a.slug asc
  -- Clamped in the function, not just in the handler: this is callable
  -- directly with the anon key, so "limit=100000" must not be a way to make
  -- the database do unbounded work.
  limit least(greatest(coalesce(result_limit, 20), 1), 50);
$$;

comment on function public.kb_search(text, text, integer) is
  'Ranked KB search. Filters status = published itself — the service_role caller bypasses RLS.';

grant execute on function public.kb_search(text, text, integer) to anon, authenticated, service_role;

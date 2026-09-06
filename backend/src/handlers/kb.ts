/**
 * Public knowledge-base endpoints.
 *
 *   GET  /kb/categories                  — the nav tree, with article counts
 *   GET  /kb/categories/{slug}           — one category and its articles
 *   GET  /kb/articles/{slug}             — one article, with related articles
 *   GET  /kb/search?q=&audience=         — ranked search
 *   POST /kb/articles/{slug}/helpful     — "yes, this helped"
 *
 * Every read filters `status = 'published'` explicitly. RLS would do it too for
 * an anon caller, but this Lambda holds the service_role key, which bypasses
 * RLS entirely — so the filters in this file are the only thing keeping drafts
 * off the public site, not a second belt over one. The same reasoning is why
 * `kb_search` carries the predicate inside the function (0038).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError } from '../lib/http.js';

const CATEGORY_COLUMNS = 'id, slug, name, description, icon, position';

/**
 * What a listing needs. Deliberately excludes `body` — see listing note below.
 *
 * `seo_description` and `updated_at` are here for the build-time prerender
 * (scripts/prerender.ts), which writes the static `<head>` a crawler sees. With
 * them, one request per section gives it everything; without them it would need
 * a detail request per article — fifty-odd round trips at every build to
 * recover two short fields. `seo_description` in particular has to be here or
 * the prerendered description and the one `useDocumentHead` sets client-side
 * would disagree on any article that overrides it.
 */
const ARTICLE_LIST_COLUMNS =
  'id, slug, title, summary, kind, audience, position, tags, seo_description, updated_at';

// `seo_description` and `updated_at` are already in the list columns above, so
// they are deliberately absent here — naming a column twice in one PostgREST
// select is at best redundant and at worst an error.
const ARTICLE_DETAIL_COLUMNS =
  `${ARTICLE_LIST_COLUMNS}, body, seo_title, helpful_yes, published_at, category_id`;

const RELATED_LIMIT = 3;
const MAX_QUERY_LENGTH = 200;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.requestContext.http.path;
  const method = event.requestContext.http.method;
  const slug = event.pathParameters?.slug;

  try {
    if (path === '/kb/search') return await search(event);
    if (path === '/kb/categories') return await listCategories();

    if (path.startsWith('/kb/categories/') && slug) return await getCategory(slug);

    if (path.endsWith('/helpful') && slug) {
      if (method !== 'POST') return badRequest(`Unsupported method ${method}`);
      return await markHelpful(slug);
    }

    if (slug) return await getArticle(slug);

    return notFound('Unknown knowledge base route');
  } catch (err) {
    return serverError('kb', err);
  }
}

/**
 * The navigation tree: every category, with how many published articles each
 * holds.
 *
 * The count is fetched as a grouped read of article category_ids rather than as
 * a per-category `count` subquery, because eight categories would otherwise be
 * eight round trips to render one sidebar.
 */
async function listCategories(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const [categories, articles] = await Promise.all([
    supabase.from('kb_categories').select(CATEGORY_COLUMNS).order('position', { ascending: true }),
    supabase.from('kb_articles').select('category_id').eq('status', 'published'),
  ]);

  if (categories.error) throw categories.error;
  if (articles.error) throw articles.error;

  const counts = new Map<string, number>();
  for (const row of articles.data ?? []) {
    const id = (row as { category_id: string }).category_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return ok({
    categories: (categories.data ?? []).map((c) => ({
      ...c,
      article_count: counts.get((c as { id: string }).id) ?? 0,
    })),
  });
}

/**
 * One category and its published articles.
 *
 * Article bodies are not returned. A category page shows titles and summaries;
 * shipping fifty markdown bodies so the browser can render fifty one-line
 * summaries is the kind of payload that is invisible on a laptop and painful on
 * a phone.
 */
async function getCategory(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: category, error } = await supabase
    .from('kb_categories')
    .select(CATEGORY_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  if (!category) return notFound('Category not found');

  const { data: articles, error: articlesError } = await supabase
    .from('kb_articles')
    .select(ARTICLE_LIST_COLUMNS)
    .eq('category_id', (category as { id: string }).id)
    .eq('status', 'published')
    .order('position', { ascending: true })
    .order('title', { ascending: true });

  if (articlesError) throw articlesError;

  return ok({ category, articles: articles ?? [] });
}

async function getArticle(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: article, error } = await supabase
    .from('kb_articles')
    .select(`${ARTICLE_DETAIL_COLUMNS}, kb_categories!kb_articles_category_id_fkey(slug, name, icon)`)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw error;
  if (!article) return notFound('Article not found');

  const related = await findRelated(
    (article as { id: string }).id,
    (article as { category_id: string }).category_id,
    ((article as { tags?: string[] }).tags ?? []),
  );

  return ok({ article, related });
}

/**
 * Related articles, derived rather than curated: same category first, then
 * anything sharing a tag.
 *
 * Derived because a curated `related_ids` column is a list fifty articles' worth
 * of editors have to maintain by hand, and the first thing that rots when an
 * article is renamed or retired. Category before tags because two articles in
 * "Sessions & Booking" are related by construction, whereas a shared tag like
 * "money" spans a client refund and a facilitator payout — genuinely related,
 * but a weaker signal.
 */
async function findRelated(
  articleId: string,
  categoryId: string,
  tags: string[],
): Promise<unknown[]> {
  const supabase = await getSupabase();

  const { data: sameCategory } = await supabase
    .from('kb_articles')
    .select(ARTICLE_LIST_COLUMNS)
    .eq('status', 'published')
    .eq('category_id', categoryId)
    .neq('id', articleId)
    .order('position', { ascending: true })
    .limit(RELATED_LIMIT);

  const related = [...(sameCategory ?? [])];
  if (related.length >= RELATED_LIMIT || tags.length === 0) {
    return related.slice(0, RELATED_LIMIT);
  }

  // Thin category — widen to shared tags. `overlaps` is `&&`, which uses the
  // GIN index from 0037.
  const excluded = [articleId, ...related.map((r) => (r as { id: string }).id)];
  const { data: sharedTags } = await supabase
    .from('kb_articles')
    .select(ARTICLE_LIST_COLUMNS)
    .eq('status', 'published')
    .overlaps('tags', tags)
    .not('id', 'in', `(${excluded.join(',')})`)
    .limit(RELATED_LIMIT - related.length);

  return [...related, ...(sharedTags ?? [])].slice(0, RELATED_LIMIT);
}

/**
 * Ranked search.
 *
 * Two passes, because `websearch_to_tsquery` ANDs bare terms: "reschedule
 * payouts" requires both words in one article and finds nothing. That is the
 * right default — it is what makes a two-word query precise — but "no results"
 * is a bad answer when a good one exists under either word. So a query that
 * returns nothing and has more than one term is retried OR-ed, and the second
 * pass is labelled in the response so the UI can say "no exact matches, showing
 * related" rather than silently pretending the loose results were the answer.
 *
 * Stop words are dropped by the tsquery parser, so "how do I reschedule my
 * session" already reduces to `reschedule & session` before either pass.
 */
async function search(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters ?? {};
  const q = (params.q ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  if (!q) return ok({ results: [], query: '', broadened: false });

  const audience =
    params.audience === 'client' || params.audience === 'facilitator' ? params.audience : null;

  const supabase = await getSupabase();

  const run = async (query: string) => {
    const { data, error } = await supabase.rpc('kb_search', {
      q: query,
      audience_filter: audience,
      result_limit: 20,
    });
    if (error) throw error;
    return data ?? [];
  };

  let results = await run(q);
  let broadened = false;

  // Only worth a second trip when there is more than one term to loosen.
  const terms = q.split(/\s+/).filter(Boolean);
  if (results.length === 0 && terms.length > 1) {
    // `or` is websearch syntax, so this stays one parameterised call — the
    // query text is never concatenated into SQL.
    results = await run(terms.join(' or '));
    broadened = results.length > 0;
  }

  return ok({ results, query: q, broadened });
}

/**
 * Records that an article helped.
 *
 * There is no matching "did not help" — see the note in 0037. A bare negative
 * count says an article failed without saying why, and the article footer
 * routes that case to support instead, where the reader can say what they
 * actually needed.
 *
 * The increment is a read-then-write rather than an atomic `+ 1`, which means
 * two clicks landing in the same instant can record as one. That is the correct
 * trade here: this number ranks articles on an internal dashboard, nobody acts
 * on its exact value, and the alternative is a database function existing
 * solely to make an approval-rating counter perfectly precise.
 */
async function markHelpful(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: article, error } = await supabase
    .from('kb_articles')
    .select('id, helpful_yes')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw error;
  if (!article) return notFound('Article not found');

  const { error: updateError } = await supabase
    .from('kb_articles')
    .update({ helpful_yes: ((article as { helpful_yes: number }).helpful_yes ?? 0) + 1 })
    .eq('id', (article as { id: string }).id);

  if (updateError) throw updateError;
  return ok({ recorded: true });
}

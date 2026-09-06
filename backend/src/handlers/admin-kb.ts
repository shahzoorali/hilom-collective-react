/**
 * Admin management of the knowledge base.
 *
 *   GET    /admin/kb/categories
 *   POST   /admin/kb/categories
 *   PATCH  /admin/kb/categories/{categoryId}
 *   DELETE /admin/kb/categories/{categoryId}
 *   GET    /admin/kb/articles
 *   POST   /admin/kb/articles
 *   GET    /admin/kb/articles/{articleId}
 *   PATCH  /admin/kb/articles/{articleId}
 *   DELETE /admin/kb/articles/{articleId}
 *   POST   /admin/kb/articles/{articleId}/publish
 *   POST   /admin/kb/articles/{articleId}/unpublish
 *   GET    /admin/kb/articles/{articleId}/revisions
 *   POST   /admin/kb/articles/{articleId}/revisions/{revisionId}/restore
 *
 * Authorized with `isAdminCaller`, the Cognito-group-or-shared-key check that
 * http.ts marks as the one new endpoints should use.
 *
 * **No draft/published body split, unlike pages and posts.** Those keep
 * `draft_blocks` and `published_blocks` side by side so an editor can revise a
 * live page without the changes going out. A KB article has one `body`, and a
 * save to a published article is live immediately. That is deliberate: the
 * common edit here is correcting a wrong instruction on a page people are
 * hitting *right now* — a refund window that changed, a button that moved — and
 * a workflow that makes a correction sit in a draft until someone remembers to
 * publish it is a workflow that leaves wrong instructions up. Revisions below
 * are the undo; publish/unpublish controls visibility, not content.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAdminCaller } from '../lib/http.js';
import {
  validateArticle,
  validateArticlePatch,
  validateCategory,
  KbInputError,
  SlugError,
} from '../lib/kb-input.js';

/** How many saves of history to keep per article. Matches admin-posts.ts. */
const REVISION_LIMIT = 20;

const CATEGORY_COLUMNS = 'id, slug, name, description, icon, position, created_at, updated_at';

const ARTICLE_COLUMNS =
  'id, slug, category_id, title, summary, kind, audience, position, tags, seo_title, ' +
  'seo_description, status, published_at, helpful_yes, created_at, updated_at';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const categoryId = event.pathParameters?.categoryId;
  const articleId = event.pathParameters?.articleId;
  const revisionId = event.pathParameters?.revisionId;

  try {
    if (path.startsWith('/admin/kb/categories')) {
      if (!categoryId) {
        if (method === 'GET') return await listCategories();
        if (method === 'POST') return await createCategory(parseBody(event));
        return badRequest(`Unsupported method ${method}`);
      }
      if (method === 'PATCH') return await updateCategory(categoryId, parseBody(event));
      if (method === 'DELETE') return await deleteCategory(categoryId);
      return badRequest(`Unsupported method ${method}`);
    }

    if (!articleId) {
      if (method === 'GET') return await listArticles();
      if (method === 'POST') return await createArticle(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.endsWith('/publish')) return await publish(articleId);
    if (path.endsWith('/unpublish')) return await unpublish(articleId);
    if (path.endsWith('/restore') && revisionId) return await restore(articleId, revisionId);
    if (path.endsWith('/revisions')) return await revisions(articleId);

    if (method === 'GET') return await getArticle(articleId);
    if (method === 'PATCH') return await updateArticle(articleId, parseBody(event));
    if (method === 'DELETE') return await deleteArticle(articleId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof KbInputError || err instanceof SlugError) {
      return badRequest(err.message);
    }
    return serverError('adminKb', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  try {
    const parsed: unknown = JSON.parse(
      event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
    );
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new KbInputError('Request body is not valid JSON');
  }
}

// =========================================================================
// Articles
// =========================================================================

/**
 * Ordered by category then position — the order the articles appear on the
 * site, not by recency.
 *
 * Explicitly *not* `updated_at desc`, which is how admin-posts.ts lists. A
 * reader clicking "this helped" writes to the article row and so fires the
 * `updated_at` trigger; ordering by it would let visitor clicks silently
 * reshuffle the editor's list, and an editor would see articles they never
 * touched drifting to the top. The KB is also a structured tree rather than a
 * feed, so tree order is the more useful view regardless.
 */
async function listArticles(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_articles')
    .select(`${ARTICLE_COLUMNS}, kb_categories!kb_articles_category_id_fkey(slug, name, position)`)
    .order('category_id', { ascending: true })
    .order('position', { ascending: true })
    .order('title', { ascending: true });

  if (error) throw error;
  return ok({ articles: data ?? [] });
}

async function getArticle(articleId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_articles')
    .select(`${ARTICLE_COLUMNS}, body, kb_categories!kb_articles_category_id_fkey(slug, name)`)
    .eq('id', articleId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Article not found');
  return ok({ article: data });
}

async function createArticle(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validateArticle(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_articles')
    .insert({ ...input, status: 'draft' })
    .select(ARTICLE_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') {
    return json(409, { error: `An article with slug "${input.slug}" already exists` });
  }
  // 23503: category_id points at a category that does not exist. A readable
  // message beats a raw FK violation, since the admin picks this from a list
  // and a stale list is the likely cause.
  if (error?.code === '23503') return badRequest('That category does not exist');
  if (error) throw error;
  return ok({ article: data });
}

async function updateArticle(
  articleId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const patch = validateArticlePatch(body);
  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  const supabase = await getSupabase();

  // Snapshot the body *before* overwriting it, and only when the body is
  // actually changing. Renaming an article or retagging it should not burn a
  // revision slot — twenty revisions of "the tags changed" would push the last
  // real draft of the text out of history, which is the one thing revisions
  // exist to hold on to.
  if (patch.body !== undefined) {
    const { data: existing } = await supabase
      .from('kb_articles')
      .select('body')
      .eq('id', articleId)
      .maybeSingle();

    const previous = (existing as { body?: string } | null)?.body;
    if (previous !== undefined && previous !== patch.body) {
      const { error: revisionError } = await supabase
        .from('kb_article_revisions')
        .insert({ article_id: articleId, body: previous, note: 'before edit' });
      // Non-fatal: losing an undo point must not lose the edit itself.
      if (revisionError) console.warn('[adminKb.update] revision insert failed', revisionError);
      await pruneRevisions(articleId);
    }
  }

  const { data, error } = await supabase
    .from('kb_articles')
    .update(patch)
    .eq('id', articleId)
    .select(ARTICLE_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: 'That slug is already in use' });
  if (error?.code === '23503') return badRequest('That category does not exist');
  if (error) throw error;
  if (!data) return notFound('Article not found');
  return ok({ article: data });
}

/**
 * Publishes an article.
 *
 * `published_at` is set once and never overwritten on a re-publish: it is the
 * date the article first went live, which is what a "last reviewed" line should
 * be measured against. An unpublish-and-republish is not the article becoming
 * new again.
 */
async function publish(articleId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('kb_articles')
    .select('id, title, body, published_at')
    .eq('id', articleId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Article not found');

  // An empty article that is live is worse than no article: it ranks in search,
  // takes the click, and answers nothing.
  if (!String((existing as { body: string }).body ?? '').trim()) {
    return badRequest('Cannot publish an article with an empty body');
  }

  const { data, error } = await supabase
    .from('kb_articles')
    .update({
      status: 'published',
      published_at: (existing as { published_at: string | null }).published_at ?? new Date().toISOString(),
    })
    .eq('id', articleId)
    .select(ARTICLE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ article: data });
}

async function unpublish(articleId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_articles')
    .update({ status: 'draft' })
    .eq('id', articleId)
    .select(ARTICLE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Article not found');
  return ok({ article: data });
}

/**
 * Hard delete, with no trash stage.
 *
 * Pages and posts get a trash because they are marketing surfaces someone may
 * want back months later. A help article that is wrong should stop being
 * reachable, and `unpublish` already does that non-destructively — so delete
 * here means the editor has decided it should not exist, and a second
 * half-deleted state to reason about buys nothing. Revisions cascade.
 */
async function deleteArticle(articleId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error } = await supabase.from('kb_articles').delete().eq('id', articleId);
  if (error) throw error;
  return ok({ deleted: true });
}

async function pruneRevisions(articleId: string): Promise<void> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_article_revisions')
    .select('id')
    .eq('article_id', articleId)
    .order('created_at', { ascending: false })
    .range(REVISION_LIMIT, REVISION_LIMIT + 200);

  if (error || !data?.length) return;
  await supabase
    .from('kb_article_revisions')
    .delete()
    .in('id', data.map((r) => (r as { id: string }).id));
}

async function revisions(articleId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_article_revisions')
    .select('id, note, created_at')
    .eq('article_id', articleId)
    .order('created_at', { ascending: false })
    .limit(REVISION_LIMIT);

  if (error) throw error;
  return ok({ revisions: data ?? [] });
}

/**
 * Restores a revision's body onto the article.
 *
 * The current body is snapshotted first, so restoring is itself undoable — a
 * restore that turns out to be the wrong revision should not be the one
 * operation in this file with no way back.
 */
async function restore(articleId: string, revisionId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: revision, error: readError } = await supabase
    .from('kb_article_revisions')
    .select('body')
    // Scoped to the article as well as the id: a revision id from another
    // article must not be restorable onto this one.
    .eq('id', revisionId)
    .eq('article_id', articleId)
    .maybeSingle();

  if (readError) throw readError;
  if (!revision) return notFound('Revision not found');

  const { data: current } = await supabase
    .from('kb_articles')
    .select('body')
    .eq('id', articleId)
    .maybeSingle();

  if (!current) return notFound('Article not found');

  const { error: snapshotError } = await supabase
    .from('kb_article_revisions')
    .insert({
      article_id: articleId,
      body: (current as { body: string }).body,
      note: 'before restore',
    });
  if (snapshotError) console.warn('[adminKb.restore] snapshot insert failed', snapshotError);

  const { data, error } = await supabase
    .from('kb_articles')
    .update({ body: (revision as { body: string }).body })
    .eq('id', articleId)
    .select(`${ARTICLE_COLUMNS}, body`)
    .maybeSingle();

  if (error) throw error;
  await pruneRevisions(articleId);
  return ok({ article: data });
}

// =========================================================================
// Categories
// =========================================================================

async function listCategories(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_categories')
    .select(CATEGORY_COLUMNS)
    .order('position', { ascending: true });

  if (error) throw error;
  return ok({ categories: data ?? [] });
}

async function createCategory(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validateCategory(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_categories')
    .insert(input)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') {
    return json(409, { error: `A category with slug "${input.slug}" already exists` });
  }
  if (error) throw error;
  return ok({ category: data });
}

async function updateCategory(
  categoryId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const input = validateCategory(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('kb_categories')
    .update(input)
    .eq('id', categoryId)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: 'That slug is already in use' });
  if (error) throw error;
  if (!data) return notFound('Category not found');
  return ok({ category: data });
}

/**
 * Deletes a category, refusing while it still holds articles.
 *
 * The FK is `on delete restrict` (0037), so the database refuses anyway — this
 * turns that into a message that says how many articles are in the way and what
 * to do about them, rather than surfacing a foreign-key violation to an editor
 * who cannot act on it.
 */
async function deleteCategory(categoryId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { count, error: countError } = await supabase
    .from('kb_articles')
    .select('id', { count: 'exact', head: true })
    .eq('category_id', categoryId);

  if (countError) throw countError;
  if ((count ?? 0) > 0) {
    return badRequest(
      `This section still holds ${count} article${count === 1 ? '' : 's'}. Move them to another section first.`,
    );
  }

  const { error } = await supabase.from('kb_categories').delete().eq('id', categoryId);
  if (error) throw error;
  return ok({ deleted: true });
}

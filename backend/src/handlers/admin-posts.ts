/**
 * Admin blog management — posts and categories.
 *
 * Posts follow the admin-pages.ts pattern: draft/published split, revisions,
 * publish triggers an Amplify rebuild via webhook. Trash, duplicate, and
 * scheduled publish also mirror admin-pages.ts exactly — see the comments
 * there for the reasoning; they are not repeated per-field here.
 *
 * Routes (one Lambda, dispatched on path):
 *   GET    /admin/posts
 *   GET    /admin/posts/trash
 *   POST   /admin/posts
 *   GET    /admin/posts/{postId}
 *   PATCH  /admin/posts/{postId}
 *   DELETE /admin/posts/{postId}                — move to trash
 *   DELETE /admin/posts/{postId}/permanent       — hard delete (trash only)
 *   POST   /admin/posts/{postId}/untrash
 *   POST   /admin/posts/{postId}/duplicate
 *   PUT    /admin/posts/{postId}/draft
 *   POST   /admin/posts/{postId}/publish         — body: { scheduledAt? }
 *   POST   /admin/posts/{postId}/unpublish        — also cancels a schedule
 *   GET    /admin/posts/{postId}/revisions
 *   POST   /admin/posts/{postId}/revisions/{revisionId}/restore
 *   GET    /admin/categories
 *   POST   /admin/categories
 *   PATCH  /admin/categories/{categoryId}
 *   DELETE /admin/categories/{categoryId}
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import {
  ok,
  notFound,
  badRequest,
  unauthorized,
  serverError,
  json,
  isAuthorizedAdmin,
} from '../lib/http.js';
import {
  validatePost,
  validateCategory,
  validateBlocks,
  BlockValidationError,
  SlugError,
} from '../lib/cms-posts.js';
import { findAvailableSlug } from '../lib/slug.js';
import { triggerAmplifyBuild } from '../lib/amplify-build.js';

/** How many publishes of history to keep per post. */
const REVISION_LIMIT = 20;

const POST_COLUMNS =
  'id, slug, title, excerpt, image_id, image_url, image_alt, author_name, author_image_url, category_id, tags, seo_title, seo_description, status, scheduled_at, deleted_at, previous_status, created_at, updated_at, published_at';

const CATEGORY_COLUMNS = 'id, slug, name, description, position, created_at, updated_at';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const postId = event.pathParameters?.postId;
  const revisionId = event.pathParameters?.revisionId;
  const categoryId = event.pathParameters?.categoryId;

  try {
    // --- Categories ---
    if (path.startsWith('/admin/categories')) {
      if (!categoryId) {
        if (method === 'GET') return listCategories();
        if (method === 'POST') return createCategory(parseBody(event));
        return badRequest(`Unsupported method ${method}`);
      }
      if (method === 'PATCH') return updateCategory(categoryId, parseBody(event));
      if (method === 'DELETE') return deleteCategory(categoryId);
      return badRequest(`Unsupported method ${method}`);
    }

    // --- Posts: trash list is a static route, not a {postId} — check first. ---
    if (path === '/admin/posts/trash') {
      if (method === 'GET') return listTrash();
      return badRequest(`Unsupported method ${method}`);
    }

    if (!postId) {
      if (method === 'GET') return listPosts();
      if (method === 'POST') return createPost(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.endsWith('/draft')) return saveDraft(postId, parseBody(event));
    if (path.endsWith('/publish')) return publish(postId, parseBody(event));
    if (path.endsWith('/unpublish')) return unpublish(postId);
    if (path.endsWith('/untrash')) return untrashPost(postId);
    if (path.endsWith('/duplicate')) return duplicatePost(postId);
    if (path.endsWith('/permanent')) return permanentlyDeletePost(postId);
    if (path.endsWith('/restore') && revisionId) return restore(postId, revisionId);
    if (path.endsWith('/revisions')) return revisions(postId);

    if (method === 'GET') return getPost(postId);
    if (method === 'PATCH') return updateMeta(postId, parseBody(event));
    if (method === 'DELETE') return trashPost(postId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (
      err instanceof BlockValidationError ||
      err instanceof SlugError ||
      (err instanceof Error &&
        (err.name === 'BlockValidationError' ||
          err.name === 'SlugError' ||
          err.message.includes('is required') ||
          err.message.includes('must be')))
    ) {
      return badRequest((err as Error).message);
    }
    return serverError('adminPosts', err);
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
    throw new BlockValidationError('Request body is not valid JSON');
  }
}

// =========================================================================
// Posts
// =========================================================================

async function listPosts(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .select(`${POST_COLUMNS}, categories!posts_category_id_fkey(slug, name)`)
    // Trash has its own view (GET /admin/posts/trash) — it must not also
    // silently reappear in the main list an editor scrolls through daily.
    .neq('status', 'trash')
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return ok({ posts: data ?? [] });
}

async function listTrash(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .select(`${POST_COLUMNS}, categories!posts_category_id_fkey(slug, name)`)
    .eq('status', 'trash')
    .order('deleted_at', { ascending: false });

  if (error) throw error;
  return ok({ posts: data ?? [] });
}

async function getPost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .select(`${POST_COLUMNS}, draft_blocks, published_blocks, categories!posts_category_id_fkey(slug, name)`)
    .eq('id', postId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Post not found');
  return ok({ post: data });
}

async function createPost(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validatePost(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .insert({ ...input, status: 'draft', draft_blocks: [], published_blocks: [] })
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: `A post with slug "${input.slug}" already exists` });
  if (error) throw error;
  return ok({ post: data });
}

async function updateMeta(
  postId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  // Re-validate only the fields being patched.
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = String(body.title).trim().slice(0, 200);
  if (body.slug !== undefined) {
    const { normalizeSlug } = await import('../lib/slug.js');
    patch.slug = normalizeSlug(body.slug);
  }
  if (body.excerpt !== undefined) patch.excerpt = body.excerpt ? String(body.excerpt).trim().slice(0, 500) : null;
  if (body.image !== undefined) {
    const image = body.image as { id?: string; url?: string; alt?: string } | null;
    if (image && typeof image === 'object' && image.url) {
      patch.image_id = typeof image.id === 'string' ? image.id : null;
      patch.image_url = image.url;
      patch.image_alt = typeof image.alt === 'string' ? image.alt.slice(0, 500) : null;
    } else {
      patch.image_id = null;
      patch.image_url = null;
      patch.image_alt = null;
    }
  }
  if (body.author_name !== undefined) patch.author_name = body.author_name ? String(body.author_name).trim().slice(0, 100) : null;
  if (body.author_image_url !== undefined) patch.author_image_url = body.author_image_url ? String(body.author_image_url).trim() : null;
  if (body.category_id !== undefined) patch.category_id = typeof body.category_id === 'string' && body.category_id ? body.category_id : null;
  if (body.tags !== undefined && Array.isArray(body.tags)) {
    patch.tags = body.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().toLowerCase().slice(0, 50)).slice(0, 20);
  }
  if (body.seo_title !== undefined) patch.seo_title = body.seo_title ? String(body.seo_title).trim().slice(0, 120) : null;
  if (body.seo_description !== undefined) patch.seo_description = body.seo_description ? String(body.seo_description).trim().slice(0, 300) : null;

  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  const { data, error } = await supabase
    .from('posts')
    .update(patch)
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: 'That slug is already in use' });
  if (error) throw error;
  if (!data) return notFound('Post not found');
  return ok({ post: data });
}

async function saveDraft(
  postId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const blocks = validateBlocks(body.blocks);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .update({ draft_blocks: blocks })
    .eq('id', postId)
    .select(`${POST_COLUMNS}, draft_blocks`)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Post not found');
  return ok({ post: data });
}

/**
 * Publish immediately, or — if `scheduledAt` is a valid future timestamp —
 * schedule it instead. A past or present `scheduledAt` publishes immediately,
 * same as WordPress treats picking a non-future date in the publish box.
 */
async function publish(postId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: post, error: readError } = await supabase
    .from('posts')
    .select('id, draft_blocks')
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!post) return notFound('Post not found');

  // Validated up front either way: a schedule with already-broken blocks
  // should fail now, at the moment the editor is looking at it, not silently
  // sit un-publishable until the sweep discovers it later.
  const blocks = validateBlocks(post.draft_blocks);

  let scheduledAtIso: string | null = null;
  if (typeof body.scheduledAt === 'string' && body.scheduledAt) {
    const parsed = new Date(body.scheduledAt);
    if (Number.isNaN(parsed.getTime())) throw new BlockValidationError('scheduledAt is not a valid date');
    if (parsed.getTime() > Date.now()) scheduledAtIso = parsed.toISOString();
  }

  if (scheduledAtIso) {
    // published_blocks/published_at are deliberately untouched: nothing goes
    // live yet, so nothing changes for a visitor and no rebuild is needed —
    // the scheduled-publish sweep does the actual publish write later.
    const { data, error } = await supabase
      .from('posts')
      .update({ status: 'scheduled', scheduled_at: scheduledAtIso, previous_status: null })
      .eq('id', postId)
      .select(POST_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    return ok({ post: data });
  }

  const { data, error } = await supabase
    .from('posts')
    .update({
      published_blocks: blocks,
      status: 'published',
      published_at: new Date().toISOString(),
      scheduled_at: null,
      previous_status: null,
    })
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  // Revision history — non-fatal, same reasoning as admin-pages.ts.
  const { error: revisionError } = await supabase
    .from('post_revisions')
    .insert({ post_id: postId, blocks, note: 'published' });
  if (revisionError) console.warn('[adminPosts.publish] revision insert failed', revisionError);

  await pruneRevisions(postId);

  // Trigger Amplify rebuild — fire-and-forget.
  triggerAmplifyBuild('adminPosts.publish').catch((err) =>
    console.warn('[adminPosts.publish] build trigger failed', err),
  );

  return ok({ post: data });
}

/** Unpublishes a live post, or cancels a pending schedule — both are "back to draft". */
async function unpublish(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing } = await supabase.from('posts').select('status').eq('id', postId).maybeSingle();
  const wasPublished = existing?.status === 'published';

  const { data, error } = await supabase
    .from('posts')
    .update({ status: 'draft', scheduled_at: null, previous_status: null })
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Post not found');

  // A cancelled schedule was never live — nothing to remove from the build.
  if (wasPublished) {
    triggerAmplifyBuild('adminPosts.unpublish').catch((err) =>
      console.warn('[adminPosts.unpublish] build trigger failed', err),
    );
  }

  return ok({ post: data });
}

async function pruneRevisions(postId: string): Promise<void> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('post_revisions')
    .select('id')
    .eq('post_id', postId)
    .order('created_at', { ascending: false })
    .range(REVISION_LIMIT, REVISION_LIMIT + 200);

  if (error || !data?.length) return;
  await supabase
    .from('post_revisions')
    .delete()
    .in(
      'id',
      data.map((r) => r.id),
    );
}

async function revisions(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('post_revisions')
    .select('id, note, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: false })
    .limit(REVISION_LIMIT);

  if (error) throw error;
  return ok({ revisions: data ?? [] });
}

async function restore(postId: string, revisionId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: revision, error: readError } = await supabase
    .from('post_revisions')
    .select('blocks')
    .eq('id', revisionId)
    .eq('post_id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!revision) return notFound('Revision not found');

  const { data, error } = await supabase
    .from('posts')
    .update({ draft_blocks: revision.blocks })
    .eq('id', postId)
    .select(`${POST_COLUMNS}, draft_blocks`)
    .maybeSingle();

  if (error) throw error;
  return ok({ post: data });
}

/** Moves a post to trash. Idempotent: trashing an already-trashed post is a no-op, not a double-trash that would clobber `previous_status`. */
async function trashPost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('posts')
    .select('status')
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Post not found');

  if (existing.status === 'trash') {
    const { data } = await supabase.from('posts').select(POST_COLUMNS).eq('id', postId).maybeSingle();
    return ok({ post: data });
  }

  const wasPublished = existing.status === 'published';

  const { data, error } = await supabase
    .from('posts')
    .update({ status: 'trash', previous_status: existing.status, deleted_at: new Date().toISOString() })
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  // A published post has a static prerendered file at /blog/<slug>/ — trashing
  // the row does not remove it. Without a rebuild that page stays live and
  // reachable, serving trashed content, until some unrelated deploy overwrites
  // it (Amplify replaces dist/ wholesale each build, so the file only
  // disappears once prerender re-runs and no longer emits it).
  if (wasPublished) {
    triggerAmplifyBuild('adminPosts.trash').catch((err) =>
      console.warn('[adminPosts.trash] build trigger failed', err),
    );
  }

  return ok({ post: data });
}

/** Restores a trashed post to whatever it was before (draft or published). */
async function untrashPost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('posts')
    .select('status, previous_status')
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Post not found');
  if (existing.status !== 'trash') return badRequest('Post is not in trash');

  const restoredStatus = existing.previous_status ?? 'draft';

  const { data, error } = await supabase
    .from('posts')
    .update({ status: restoredStatus, previous_status: null, deleted_at: null })
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  if (restoredStatus === 'published') {
    triggerAmplifyBuild('adminPosts.untrash').catch((err) =>
      console.warn('[adminPosts.untrash] build trigger failed', err),
    );
  }

  return ok({ post: data });
}

/** Hard delete — only ever reachable on a row already sitting in trash. */
async function permanentlyDeletePost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('posts')
    .select('status')
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Post not found');
  if (existing.status !== 'trash') {
    return badRequest('Only a trashed post can be permanently deleted — move it to trash first.');
  }

  // post_revisions cascades via its FK; nothing else references a post.
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) throw error;
  return ok({ deleted: true });
}

/**
 * Copies a post's editable content into a new draft — title suffixed
 * "(Copy)", slug de-duplicated. Copies `draft_blocks` (the content an editor
 * was actually looking at), never `published_blocks`, and always lands as a
 * fresh, unpublished draft regardless of the source's status.
 */
async function duplicatePost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: original, error: readError } = await supabase
    .from('posts')
    .select(
      'title, slug, excerpt, image_id, image_url, image_alt, author_name, author_image_url, category_id, tags, seo_title, seo_description, draft_blocks',
    )
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!original) return notFound('Post not found');

  const slug = await findAvailableSlug(`${original.slug}-copy`, async (candidate) => {
    const { count, error } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('slug', candidate);
    if (error) throw error;
    return (count ?? 0) > 0;
  });

  const { data, error } = await supabase
    .from('posts')
    .insert({
      title: `${original.title} (Copy)`.slice(0, 200),
      slug,
      excerpt: original.excerpt,
      image_id: original.image_id,
      image_url: original.image_url,
      image_alt: original.image_alt,
      author_name: original.author_name,
      author_image_url: original.author_image_url,
      category_id: original.category_id,
      tags: original.tags,
      seo_title: original.seo_title,
      seo_description: original.seo_description,
      status: 'draft',
      draft_blocks: original.draft_blocks,
      published_blocks: [],
    })
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ post: data });
}

// =========================================================================
// Categories
// =========================================================================

async function listCategories(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .order('position', { ascending: true });

  if (error) throw error;
  return ok({ categories: data ?? [] });
}

async function createCategory(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validateCategory(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('categories')
    .insert(input)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: `A category with slug "${input.slug}" already exists` });
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
    .from('categories')
    .update(input)
    .eq('id', categoryId)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: 'That slug is already in use' });
  if (error) throw error;
  if (!data) return notFound('Category not found');
  return ok({ category: data });
}

async function deleteCategory(categoryId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error } = await supabase.from('categories').delete().eq('id', categoryId);
  if (error) throw error;
  return ok({ deleted: true });
}

/**
 * Admin blog management — posts and categories.
 *
 * Posts follow the admin-pages.ts pattern: draft/published split, revisions,
 * publish triggers an Amplify rebuild via webhook.
 *
 * Routes (one Lambda, dispatched on path):
 *   GET    /admin/posts
 *   POST   /admin/posts
 *   GET    /admin/posts/{postId}
 *   PATCH  /admin/posts/{postId}
 *   DELETE /admin/posts/{postId}
 *   PUT    /admin/posts/{postId}/draft
 *   POST   /admin/posts/{postId}/publish
 *   POST   /admin/posts/{postId}/unpublish
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
import { getSecret } from '../lib/secrets.js';

/** How many publishes of history to keep per post. */
const REVISION_LIMIT = 20;

const POST_COLUMNS =
  'id, slug, title, excerpt, image_id, image_url, image_alt, author_name, author_image_url, category_id, tags, seo_title, seo_description, status, created_at, updated_at, published_at';

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

    // --- Posts ---
    if (!postId) {
      if (method === 'GET') return listPosts();
      if (method === 'POST') return createPost(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.endsWith('/draft')) return saveDraft(postId, parseBody(event));
    if (path.endsWith('/publish')) return publish(postId);
    if (path.endsWith('/unpublish')) return unpublish(postId);
    if (path.endsWith('/restore') && revisionId) return restore(postId, revisionId);
    if (path.endsWith('/revisions')) return revisions(postId);

    if (method === 'GET') return getPost(postId);
    if (method === 'PATCH') return updateMeta(postId, parseBody(event));
    if (method === 'DELETE') return deletePost(postId);
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
    .order('updated_at', { ascending: false });

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

async function publish(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: post, error: readError } = await supabase
    .from('posts')
    .select('id, draft_blocks')
    .eq('id', postId)
    .maybeSingle();

  if (readError) throw readError;
  if (!post) return notFound('Post not found');

  const blocks = validateBlocks(post.draft_blocks);

  const { data, error } = await supabase
    .from('posts')
    .update({ published_blocks: blocks, status: 'published', published_at: new Date().toISOString() })
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
  triggerBuild().catch((err) => console.warn('[adminPosts.publish] build trigger failed', err));

  return ok({ post: data });
}

async function unpublish(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('posts')
    .update({ status: 'draft' })
    .eq('id', postId)
    .select(POST_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Post not found');

  // Trigger rebuild so the prerendered page is removed.
  triggerBuild().catch((err) => console.warn('[adminPosts.unpublish] build trigger failed', err));

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

async function deletePost(postId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) throw error;
  return ok({ deleted: true });
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

// =========================================================================
// Amplify rebuild trigger
// =========================================================================

async function triggerBuild(): Promise<void> {
  const secretId = process.env.BUILD_HOOK_SECRET_ID;
  if (!secretId) {
    console.warn('[triggerBuild] BUILD_HOOK_SECRET_ID not set, skipping');
    return;
  }

  const { url } = await getSecret<{ url: string }>(secretId);
  if (!url) {
    console.warn('[triggerBuild] No webhook URL in secret, skipping');
    return;
  }

  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    console.warn(`[triggerBuild] webhook returned ${res.status}`);
  }
}

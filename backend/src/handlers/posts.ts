/**
 * Public blog endpoints.
 *
 *   GET /posts              — paginated list, optional category/tag filters
 *   GET /posts/{slug}       — single post with related posts
 *   GET /categories         — all categories ordered by position
 *
 * All queries filter on `status = 'published'` via RLS (anon role), so
 * drafts are invisible without explicit service_role access.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, serverError } from '../lib/http.js';

const POST_COLUMNS =
  'id, slug, title, excerpt, image_url, image_alt, author_name, author_image_url, category_id, tags, published_at';

const POST_DETAIL_COLUMNS =
  `${POST_COLUMNS}, published_blocks, seo_title, seo_description`;

const CATEGORY_COLUMNS = 'id, slug, name, description, position';

const PAGE_SIZE = 12;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.requestContext.http.path;
  const slug = event.pathParameters?.slug;

  try {
    if (path === '/categories') return listCategories();
    if (slug) return getPost(slug);
    return listPosts(event);
  } catch (err) {
    return serverError('posts', err);
  }
}

async function listPosts(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const params = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(params.page ?? '1', 10));
  const limit = PAGE_SIZE;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('posts')
    .select(`${POST_COLUMNS}, categories!posts_category_id_fkey(slug, name)`, { count: 'exact' })
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Filter by category slug.
  if (params.category) {
    // Look up category ID first.
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('slug', params.category)
      .maybeSingle();
    if (cat) query = query.eq('category_id', cat.id);
    else return ok({ posts: [], total: 0, page, pageSize: limit });
  }

  // Filter by tag.
  if (params.tag) {
    query = query.contains('tags', [params.tag]);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return ok({
    posts: data ?? [],
    total: count ?? 0,
    page,
    pageSize: limit,
  });
}

async function getPost(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: post, error } = await supabase
    .from('posts')
    .select(`${POST_DETAIL_COLUMNS}, categories!posts_category_id_fkey(slug, name)`)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw error;
  if (!post) return notFound('Post not found');

  // Related posts: same category, excluding self, newest first, limit 3.
  // Fall back to recent posts if category is thin.
  let related: unknown[] = [];
  if (post.category_id) {
    const { data: sameCat } = await supabase
      .from('posts')
      .select(POST_COLUMNS)
      .eq('status', 'published')
      .eq('category_id', post.category_id)
      .neq('id', post.id)
      .order('published_at', { ascending: false })
      .limit(3);
    related = sameCat ?? [];
  }

  // Fallback if category is thin or post has no category.
  if (related.length < 3) {
    const existingIds = [post.id, ...related.map((r: any) => r.id)];
    const { data: recent } = await supabase
      .from('posts')
      .select(POST_COLUMNS)
      .eq('status', 'published')
      .not('id', 'in', `(${existingIds.join(',')})`)
      .order('published_at', { ascending: false })
      .limit(3 - related.length);
    related = [...related, ...(recent ?? [])];
  }

  return ok({ post: { ...post, blocks: post.published_blocks }, related });
}

async function listCategories(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .order('position', { ascending: true });

  if (error) throw error;
  return ok({ categories: data ?? [] });
}

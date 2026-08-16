/**
 * Public CMS page reads.
 *
 * GET /pages         — slugs + titles of published pages
 * GET /pages/{slug}  — one published page, with its blocks
 *
 * One Lambda serves both routes, dispatching on the presence of a path
 * parameter. The commerce endpoints in this backend use one function per
 * endpoint, but the CMS adds ~25 routes, and following that literally would
 * mean ~25 more functions, log groups, and secret grants for no isolation
 * benefit — these are all cheap reads of the same table with the same
 * permissions.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, serverError } from '../lib/http.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const slug = event.pathParameters?.slug;
  return slug === undefined ? list() : detail(slug);
}

async function list(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('pages')
      .select('slug, title, updated_at')
      .eq('status', 'published')
      .order('slug');

    if (error) throw error;
    return ok({ pages: data ?? [] });
  } catch (err) {
    return serverError('pages.list', err);
  }
}

async function detail(slug: string): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('pages')
      // draft_blocks is deliberately not selected: unpublished copy must never
      // leave the backend on a public route.
      .select('slug, title, seo_title, seo_description, published_blocks, published_at')
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle();

    if (error) throw error;
    if (!data) return notFound('Page not found');

    const { published_blocks, ...page } = data as Record<string, unknown> & {
      published_blocks: unknown;
    };
    return ok({ page: { ...page, blocks: published_blocks ?? [] } });
  } catch (err) {
    return serverError('pages.detail', err);
  }
}

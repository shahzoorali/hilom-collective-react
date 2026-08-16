/**
 * Admin CMS page management. All routes require the shared admin key.
 *
 * Draft and published content are separate columns on the same row, so editing
 * a live page can never change what visitors see until publish is pressed, and
 * publish is the only write that ever touches `published_blocks`.
 *
 * Routes (one Lambda, dispatched on path — see the note in pages.ts):
 *   GET    /admin/pages
 *   POST   /admin/pages
 *   GET    /admin/pages/{pageId}
 *   PATCH  /admin/pages/{pageId}
 *   DELETE /admin/pages/{pageId}
 *   PUT    /admin/pages/{pageId}/draft
 *   POST   /admin/pages/{pageId}/publish
 *   POST   /admin/pages/{pageId}/unpublish
 *   GET    /admin/pages/{pageId}/revisions
 *   POST   /admin/pages/{pageId}/revisions/{revisionId}/restore
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
import { validateBlocks, BlockValidationError } from '../lib/cms-blocks.js';
import { normalizeSlug, slugify, SlugError } from '../lib/slug.js';

/** How many publishes of history to keep per page. */
const REVISION_LIMIT = 20;

const PAGE_COLUMNS =
  'id, slug, title, status, seo_title, seo_description, is_system, created_at, updated_at, published_at';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const pageId = event.pathParameters?.pageId;
  const revisionId = event.pathParameters?.revisionId;
  const path = event.requestContext.http.path;

  try {
    if (!pageId) {
      if (method === 'GET') return list();
      if (method === 'POST') return create(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.endsWith('/draft')) return saveDraft(pageId, parseBody(event));
    if (path.endsWith('/publish')) return publish(pageId);
    if (path.endsWith('/unpublish')) return unpublish(pageId);
    if (path.endsWith('/restore') && revisionId) return restore(pageId, revisionId);
    if (path.endsWith('/revisions')) return revisions(pageId);

    if (method === 'GET') return get(pageId);
    if (method === 'PATCH') return updateMeta(pageId, parseBody(event));
    if (method === 'DELETE') return remove(pageId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    // Validation failures are the caller's fault and must say what was wrong;
    // everything else is logged and returned as an opaque 500.
    if (err instanceof BlockValidationError || err instanceof SlugError) {
      return badRequest(err.message);
    }
    return serverError('adminPages', err);
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

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('pages').select(PAGE_COLUMNS).order('title');

  if (error) throw error;
  return ok({ pages: data ?? [] });
}

async function get(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .select(`${PAGE_COLUMNS}, draft_blocks, published_blocks`)
    .eq('id', pageId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Page not found');
  return ok({ page: data });
}

async function create(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const title = String(body.title ?? '').trim();
  if (!title) return badRequest('title is required');

  const slug = normalizeSlug(body.slug ? body.slug : slugify(title));

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .insert({ title, slug, status: 'draft', draft_blocks: [], published_blocks: [] })
    .select(PAGE_COLUMNS)
    .maybeSingle();

  // 23505 = unique_violation. A duplicate slug is a normal thing for an editor
  // to do and deserves a real message, not a 500.
  if (error?.code === '23505') return json(409, { error: `A page with slug "${slug}" already exists` });
  if (error) throw error;
  return ok({ page: data });
}

async function updateMeta(
  pageId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('pages')
    .select('id, is_system')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Page not found');

  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.seo_title === 'string') patch.seo_title = body.seo_title.trim() || null;
  if (typeof body.seo_description === 'string') {
    patch.seo_description = body.seo_description.trim() || null;
  }
  if (body.slug !== undefined) {
    // The nav and in-page CTAs link to system slugs by path, so renaming one
    // would break links that live in code rather than in the CMS.
    if (existing.is_system) return badRequest('The slug of a built-in page cannot be changed');
    patch.slug = normalizeSlug(body.slug);
  }
  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  const { data, error } = await supabase
    .from('pages')
    .update(patch)
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: 'That slug is already in use' });
  if (error) throw error;
  return ok({ page: data });
}

async function saveDraft(
  pageId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const blocks = validateBlocks(body.blocks);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .update({ draft_blocks: blocks })
    .eq('id', pageId)
    .select(`${PAGE_COLUMNS}, draft_blocks`)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Page not found');
  return ok({ page: data });
}

async function publish(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: page, error: readError } = await supabase
    .from('pages')
    .select('id, draft_blocks')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!page) return notFound('Page not found');

  // Re-validated on the way out as well as on the way in: a draft could have
  // been stored before a block type was removed from the catalog.
  const blocks = validateBlocks(page.draft_blocks);

  const { data, error } = await supabase
    .from('pages')
    .update({ published_blocks: blocks, status: 'published', published_at: new Date().toISOString() })
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  const { error: revisionError } = await supabase
    .from('page_revisions')
    .insert({ page_id: pageId, blocks, note: 'published' });
  // History is a convenience, not the money path: failing to record it must not
  // fail a publish that already succeeded.
  if (revisionError) console.warn('[adminPages.publish] revision insert failed', revisionError);

  await pruneRevisions(pageId);
  return ok({ page: data });
}

async function pruneRevisions(pageId: string): Promise<void> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('page_revisions')
    .select('id')
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .range(REVISION_LIMIT, REVISION_LIMIT + 200);

  if (error || !data?.length) return;
  await supabase
    .from('page_revisions')
    .delete()
    .in(
      'id',
      data.map((r) => r.id),
    );
}

async function unpublish(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .update({ status: 'draft' })
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Page not found');
  return ok({ page: data });
}

async function revisions(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('page_revisions')
    .select('id, note, created_at')
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(REVISION_LIMIT);

  if (error) throw error;
  return ok({ revisions: data ?? [] });
}

/** Copies an old revision back into the draft. Publishing it stays a separate,
 *  deliberate step, so restoring can't put unreviewed content live. */
async function restore(pageId: string, revisionId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: revision, error: readError } = await supabase
    .from('page_revisions')
    .select('blocks')
    .eq('id', revisionId)
    .eq('page_id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!revision) return notFound('Revision not found');

  const { data, error } = await supabase
    .from('pages')
    .update({ draft_blocks: revision.blocks })
    .eq('id', pageId)
    .select(`${PAGE_COLUMNS}, draft_blocks`)
    .maybeSingle();

  if (error) throw error;
  return ok({ page: data });
}

async function remove(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: page, error: readError } = await supabase
    .from('pages')
    .select('id, is_system')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!page) return notFound('Page not found');
  if (page.is_system) {
    return badRequest('Built-in pages cannot be deleted. Unpublish it instead.');
  }

  const { error } = await supabase.from('pages').delete().eq('id', pageId);
  if (error) throw error;
  return ok({ deleted: true });
}

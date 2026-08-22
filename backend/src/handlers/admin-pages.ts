/**
 * Admin CMS page management. All routes require the shared admin key.
 *
 * Draft and published content are separate columns on the same row, so editing
 * a live page can never change what visitors see until publish is pressed, and
 * publish is the only write that ever touches `published_blocks`.
 *
 * Trash, duplicate, and scheduled publish here are the pages side of the same
 * feature as admin-posts.ts — reasoning lives in the comments over there and
 * isn't repeated per-field in this file.
 *
 * None of this touches Amplify. CmsPage.tsx fetches a page live and the
 * public API filters status = 'published', so a write here takes effect for
 * visitors immediately — the same as every other admin action. The
 * prerendered <head> (title/description/og:image) only refreshes on the next
 * real code deploy, which is a freshness detail, not a correctness one.
 *
 * Routes (one Lambda, dispatched on path — see the note in pages.ts):
 *   GET    /admin/pages
 *   GET    /admin/pages/trash
 *   POST   /admin/pages
 *   GET    /admin/pages/{pageId}
 *   PATCH  /admin/pages/{pageId}
 *   DELETE /admin/pages/{pageId}              — move to trash (system pages excluded)
 *   DELETE /admin/pages/{pageId}/permanent     — hard delete (trash only)
 *   POST   /admin/pages/{pageId}/untrash
 *   POST   /admin/pages/{pageId}/duplicate
 *   PUT    /admin/pages/{pageId}/draft
 *   POST   /admin/pages/{pageId}/publish       — body: { scheduledAt? }
 *   POST   /admin/pages/{pageId}/unpublish      — also cancels a schedule
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
import { normalizeSlug, slugify, SlugError, findAvailableSlug } from '../lib/slug.js';

/** How many publishes of history to keep per page. */
const REVISION_LIMIT = 20;

const PAGE_COLUMNS =
  'id, slug, title, status, seo_title, seo_description, is_system, scheduled_at, deleted_at, previous_status, created_at, updated_at, published_at';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const pageId = event.pathParameters?.pageId;
  const revisionId = event.pathParameters?.revisionId;
  const path = event.requestContext.http.path;

  try {
    // Trash list is a static route, not a {pageId} — check first.
    if (path === '/admin/pages/trash') {
      if (method === 'GET') return await listTrash();
      return badRequest(`Unsupported method ${method}`);
    }

    if (!pageId) {
      if (method === 'GET') return await list();
      if (method === 'POST') return await create(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.endsWith('/draft')) return await saveDraft(pageId, parseBody(event));
    if (path.endsWith('/publish')) return await publish(pageId, parseBody(event));
    if (path.endsWith('/unpublish')) return await unpublish(pageId);
    if (path.endsWith('/untrash')) return await untrashPage(pageId);
    if (path.endsWith('/duplicate')) return await duplicatePage(pageId);
    if (path.endsWith('/permanent')) return await permanentlyDeletePage(pageId);
    if (path.endsWith('/restore') && revisionId) return await restore(pageId, revisionId);
    if (path.endsWith('/revisions')) return await revisions(pageId);

    if (method === 'GET') return await get(pageId);
    if (method === 'PATCH') return await updateMeta(pageId, parseBody(event));
    if (method === 'DELETE') return await trashPage(pageId);
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
  const { data, error } = await supabase
    .from('pages')
    .select(PAGE_COLUMNS)
    // Trash has its own view (GET /admin/pages/trash) — it must not also
    // silently reappear in the main list an editor scrolls through daily.
    .neq('status', 'trash')
    .order('title');

  if (error) throw error;
  return ok({ pages: data ?? [] });
}

async function listTrash(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .select(PAGE_COLUMNS)
    .eq('status', 'trash')
    .order('deleted_at', { ascending: false });

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

/**
 * Publish immediately, or — if `scheduledAt` is a valid future timestamp —
 * schedule it instead. A past or present `scheduledAt` publishes immediately,
 * same as WordPress treats picking a non-future date in the publish box.
 */
async function publish(pageId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
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
      .from('pages')
      .update({ status: 'scheduled', scheduled_at: scheduledAtIso, previous_status: null })
      .eq('id', pageId)
      .select(PAGE_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    return ok({ page: data });
  }

  const { data, error } = await supabase
    .from('pages')
    .update({
      published_blocks: blocks,
      status: 'published',
      published_at: new Date().toISOString(),
      scheduled_at: null,
      previous_status: null,
    })
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

/** Unpublishes a live page, or cancels a pending schedule — both are "back to draft". */
async function unpublish(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('pages')
    .update({ status: 'draft', scheduled_at: null, previous_status: null })
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

/** Moves a page to trash. Idempotent: trashing an already-trashed page is a no-op, not a double-trash that would clobber `previous_status`. */
async function trashPage(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('pages')
    .select('status, is_system')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Page not found');
  if (existing.is_system) {
    return badRequest('Built-in pages cannot be trashed. Unpublish it instead.');
  }

  if (existing.status === 'trash') {
    const { data } = await supabase.from('pages').select(PAGE_COLUMNS).eq('id', pageId).maybeSingle();
    return ok({ page: data });
  }

  const { data, error } = await supabase
    .from('pages')
    .update({ status: 'trash', previous_status: existing.status, deleted_at: new Date().toISOString() })
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ page: data });
}

/** Restores a trashed page to whatever it was before (draft or published). */
async function untrashPage(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('pages')
    .select('status, previous_status')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Page not found');
  if (existing.status !== 'trash') return badRequest('Page is not in trash');

  const restoredStatus = existing.previous_status ?? 'draft';

  const { data, error } = await supabase
    .from('pages')
    .update({ status: restoredStatus, previous_status: null, deleted_at: null })
    .eq('id', pageId)
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ page: data });
}

/** Hard delete — only ever reachable on a row already sitting in trash. */
async function permanentlyDeletePage(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: existing, error: readError } = await supabase
    .from('pages')
    .select('status')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return notFound('Page not found');
  if (existing.status !== 'trash') {
    return badRequest('Only a trashed page can be permanently deleted — move it to trash first.');
  }

  // page_revisions cascades via its FK; nothing else references a page.
  const { error } = await supabase.from('pages').delete().eq('id', pageId);
  if (error) throw error;
  return ok({ deleted: true });
}

/**
 * Copies a page's editable content into a new draft — title suffixed
 * "(Copy)", slug de-duplicated. Copies `draft_blocks` (the content an editor
 * was actually looking at), never `published_blocks`, always lands as a fresh
 * unpublished draft regardless of the source's status, and is never itself a
 * system page — nothing in code references the duplicate's new slug, even
 * when duplicating a built-in page.
 */
async function duplicatePage(pageId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: original, error: readError } = await supabase
    .from('pages')
    .select('title, slug, seo_title, seo_description, draft_blocks')
    .eq('id', pageId)
    .maybeSingle();

  if (readError) throw readError;
  if (!original) return notFound('Page not found');

  const slug = await findAvailableSlug(`${original.slug}-copy`, async (candidate) => {
    const { count, error } = await supabase
      .from('pages')
      .select('id', { count: 'exact', head: true })
      .eq('slug', candidate);
    if (error) throw error;
    return (count ?? 0) > 0;
  });

  const { data, error } = await supabase
    .from('pages')
    .insert({
      title: `${original.title} (Copy)`.slice(0, 200),
      slug,
      seo_title: original.seo_title,
      seo_description: original.seo_description,
      status: 'draft',
      is_system: false,
      draft_blocks: original.draft_blocks,
      published_blocks: [],
    })
    .select(PAGE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ page: data });
}

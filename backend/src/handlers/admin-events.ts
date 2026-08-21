/**
 * Admin event management.
 *
 *   GET    /admin/events
 *   POST   /admin/events
 *   GET    /admin/events/{eventId}
 *   PUT    /admin/events/{eventId}
 *   DELETE /admin/events/{eventId}
 *
 * No draft/publish split beyond the `status` column itself — unlike pages,
 * an event has no separate "what visitors see" copy to protect while editing,
 * so there is nothing a two-column draft/published pair would buy here.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { validateEvent } from '../lib/cms-events.js';
import { BlockValidationError } from '../lib/cms-blocks.js';

const COLUMNS =
  'id, title, subtitle, description, image_id, image_url, image_alt, location, starts_at, ends_at, link_url, link_label, note, status, created_at, updated_at';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const eventId = event.pathParameters?.eventId;

  try {
    if (!eventId) {
      if (method === 'GET') return list();
      if (method === 'POST') return create(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'GET') return get(eventId);
    if (method === 'PUT') return update(eventId, parseBody(event));
    if (method === 'DELETE') return remove(eventId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof BlockValidationError) return badRequest(err.message);
    return serverError('adminEvents', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new BlockValidationError('Request body is not valid JSON');
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('events').select(COLUMNS).order('starts_at', { ascending: false });
  if (error) throw error;
  return ok({ events: data ?? [] });
}

async function get(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('events').select(COLUMNS).eq('id', eventId).maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');
  return ok({ event: data });
}

async function create(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validateEvent(body);
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('events')
    .insert({ ...input, status: body.status === 'published' ? 'published' : 'draft' })
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return ok({ event: data });
}

async function update(eventId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const input = validateEvent(body);
  const patch: Record<string, unknown> = { ...input };
  if (body.status === 'published' || body.status === 'draft') patch.status = body.status;

  const supabase = await getSupabase();
  const { data, error } = await supabase.from('events').update(patch).eq('id', eventId).select(COLUMNS).maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Event not found');
  return ok({ event: data });
}

async function remove(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error } = await supabase.from('events').delete().eq('id', eventId);
  if (error) throw error;
  return ok({ deleted: true });
}

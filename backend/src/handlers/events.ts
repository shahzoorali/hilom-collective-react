/**
 * GET /events — published events, split into upcoming and past.
 *
 * The split happens here rather than in the frontend so "what counts as past"
 * has one implementation: coalesce(ends_at, starts_at) < now(), evaluated at
 * request time in the database, not recomputed client-side from timestamps
 * that could disagree with the server's clock.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, serverError } from '../lib/http.js';

const COLUMNS =
  'id, title, subtitle, description, image_url, image_alt, location, starts_at, ends_at, link_url, link_label, note';

export async function handler(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const nowIso = new Date().toISOString();

    const [{ data: upcoming, error: upcomingError }, { data: past, error: pastError }] =
      await Promise.all([
        supabase
          .from('events')
          .select(COLUMNS)
          .eq('status', 'published')
          // An event with no end time counts as upcoming until its start
          // time passes; `.or` expresses "ends_at is null AND starts_at in
          // the future" OR "ends_at is set and still in the future" without a
          // computed column.
          .or(`ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${nowIso})`)
          .order('starts_at', { ascending: true }),
        supabase
          .from('events')
          .select(COLUMNS)
          .eq('status', 'published')
          .or(`ends_at.lt.${nowIso},and(ends_at.is.null,starts_at.lt.${nowIso})`)
          // Most recently ended first — the past section reads newest-to-oldest.
          .order('starts_at', { ascending: false }),
      ]);

    if (upcomingError) throw upcomingError;
    if (pastError) throw pastError;

    return ok({ upcoming: upcoming ?? [], past: past ?? [] });
  } catch (err) {
    return serverError('events.list', err);
  }
}

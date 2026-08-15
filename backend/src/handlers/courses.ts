/**
 * GET /courses — the cached Moodle course list.
 *
 * `last_synced_at` is returned deliberately: the sync is manual, so any consumer
 * of this data needs to be able to show how stale it is.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, serverError } from '../lib/http.js';

export async function list(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('courses')
      .select('moodle_course_id, fullname, shortname, summary, image_url, enrolled_count, visible, last_synced_at')
      .order('moodle_course_id', { ascending: true });

    if (error) throw error;

    const courses = data ?? [];
    const lastSyncedAt = courses.reduce<string | null>(
      (latest, c) => (!latest || c.last_synced_at > latest ? c.last_synced_at : latest),
      null,
    );

    return ok({ courses, last_synced_at: lastSyncedAt });
  } catch (err) {
    return serverError('courses.list', err);
  }
}

/**
 * Admin endpoints. Protected by a shared key header until Phase 7 moves them
 * behind a Cognito admin group.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getMoodleSecret } from '../lib/secrets.js';
import { MoodleClient } from '../lib/moodle.js';
import { fulfillOrder } from '../lib/fulfillment.js';
import { ok, json, badRequest, notFound, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';

/**
 * POST /admin/sync-courses
 *
 * Read-only against Moodle, upserting into the `courses` cache. Moodle is the
 * source of truth; this never writes back to it.
 */
export async function syncCourses(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  try {
    const { token, url } = await getMoodleSecret();
    const moodle = new MoodleClient(token, url);

    // getCourses() already drops the site-level pseudo-course (id 1), which is
    // not a real course and must never be sold or enrolled into.
    const courses = await moodle.getCourses();

    const rows = courses.map((c) => ({
      moodle_course_id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      summary: c.summary ?? null,
      visible: Boolean(c.visible),
      last_synced_at: new Date().toISOString(),
    }));

    const supabase = await getSupabase();
    const { error } = await supabase
      .from('courses')
      .upsert(rows, { onConflict: 'moodle_course_id' });

    if (error) throw error;

    return ok({
      synced: rows.length,
      last_synced_at: rows[0]?.last_synced_at ?? null,
      courses: rows.map((r) => ({ id: r.moodle_course_id, shortname: r.shortname })),
    });
  } catch (err) {
    return serverError('admin.syncCourses', err);
  }
}

/**
 * POST /admin/retry-enrollment/{orderId}
 *
 * Admin-triggered re-run of fulfillment for a stuck order — the same
 * fulfillOrder() the webhook and the SQS retry consumer use, so behavior is
 * identical across all three trigger paths. Safe to click repeatedly: an
 * already-fulfilled order returns early without re-enrolling.
 */
export async function retryEnrollment(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return badRequest('Missing orderId');

  try {
    const result = await fulfillOrder(orderId);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === `Order ${orderId} not found`) {
      return notFound(`Order ${orderId} not found`);
    }
    return serverError('admin.retryEnrollment', err);
  }
}

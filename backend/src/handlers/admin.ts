/**
 * Admin endpoints. Protected by a shared key header until Phase 7 moves them
 * behind a Cognito admin group.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getMoodleSecret } from '../lib/secrets.js';
import { MoodleClient } from '../lib/moodle.js';
import { fulfillOrder } from '../lib/fulfillment.js';
import { revokeOrderAccess } from '../lib/revocation.js';
import { ok, json, badRequest, notFound, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';

const COURSE_IMAGES_BUCKET = 'course-images';

/**
 * Moodle's overview file URL requires the WS token to load and must never
 * reach the frontend (that would leak the backend's Moodle secret to every
 * visitor). So the image is fetched here, server-side, with the token, and
 * re-hosted in a public Supabase Storage bucket — the frontend only ever sees
 * that public URL.
 */
async function mirrorCourseImage(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  moodle: MoodleClient,
  course: { id: number; overviewfiles?: { filename: string; fileurl: string; mimetype: string }[] },
): Promise<string | null> {
  const file = course.overviewfiles?.[0];
  if (!file) return null;

  const res = await fetch(moodle.authenticatedFileUrl(file.fileurl));
  // Moodle's pluginfile.php returns HTTP 200 even on failure (e.g. "file
  // downloading" disabled on the external service) with a JSON error body
  // instead of image bytes — res.ok alone would happily "succeed" uploading
  // that error page as if it were the course image.
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.startsWith('image/')) {
    const preview = await res.text().catch(() => '');
    console.warn(
      `[admin.syncCourses] image fetch for course ${course.id} did not return an image ` +
        `(HTTP ${res.status}, content-type "${contentType}"): ${preview.slice(0, 300)}`,
    );
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const ext = file.filename.includes('.') ? file.filename.split('.').pop() : 'jpg';
  const path = `${course.id}.${ext}`;
  const { error } = await supabase.storage
    .from(COURSE_IMAGES_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) {
    console.warn(`[admin.syncCourses] image upload failed for course ${course.id}:`, error.message);
    return null;
  }

  return supabase.storage.from(COURSE_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * POST /admin/sync-courses
 *
 * Read-only against Moodle, upserting into the `courses` cache. Moodle is the
 * source of truth; this never writes back to it. Course images are mirrored
 * into Supabase Storage rather than linked directly (see mirrorCourseImage).
 */
export async function syncCourses(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  try {
    const { token, url } = await getMoodleSecret();
    const moodle = new MoodleClient(token, url);
    const supabase = await getSupabase();

    // getCoursesWithImages() already drops the site-level pseudo-course (id 1),
    // which is not a real course and must never be sold or enrolled into.
    const courses = await moodle.getCoursesWithImages();

    const rows = await Promise.all(
      courses.map(async (c) => {
        let enrolledCount: number | null = null;
        try {
          enrolledCount = await moodle.getEnrolledCount(c.id);
        } catch (err) {
          console.warn(`[admin.syncCourses] enrolled count fetch failed for course ${c.id}:`, err);
        }
        let contentHtml: string | null = null;
        try {
          contentHtml = await moodle.getLabelContent(c.id);
        } catch (err) {
          console.warn(`[admin.syncCourses] content fetch failed for course ${c.id}:`, err);
        }
        return {
          moodle_course_id: c.id,
          fullname: c.fullname,
          shortname: c.shortname,
          summary: c.summary ?? null,
          content_html: contentHtml,
          visible: Boolean(c.visible),
          image_url: await mirrorCourseImage(supabase, moodle, c),
          enrolled_count: enrolledCount,
          last_synced_at: new Date().toISOString(),
        };
      }),
    );

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

/**
 * POST /admin/revoke-access/{orderId}
 *
 * Phase 8 refund handling. The refund itself is processed manually in the
 * PayMongo dashboard (a locked decision — no refund automation); this removes
 * the course access that order granted and marks the order `refunded`.
 *
 * Does not delete the buyer's Moodle or Cognito account: they may hold other
 * purchases, and destroying an identity over one refund would be an
 * unrecoverable action taken on the customer's behalf.
 */
export async function revokeAccess(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return badRequest('Missing orderId');

  try {
    const result = await revokeOrderAccess(orderId);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === `Order ${orderId} not found`) {
      return notFound(`Order ${orderId} not found`);
    }
    return serverError('admin.revokeAccess', err);
  }
}

/**
 * Media library. Uploads are presign → browser PUT → confirm.
 *
 *   GET    /admin/media              — library listing
 *   POST   /admin/media/upload-url   — presigned PUT for a single file
 *   POST   /admin/media              — confirm an upload landed, create the row
 *   PATCH  /admin/media/{mediaId}    — edit alt text
 *   DELETE /admin/media/{mediaId}    — delete, unless a page still uses it
 *
 * The row is written only on confirm, so an abandoned upload leaves an orphan S3
 * object rather than a library entry pointing at nothing. Confirm re-checks the
 * object with HeadObject instead of trusting the browser's word for it — the
 * same instinct as mirrorCourseImage in admin.ts, which refuses to trust a 200
 * that isn't really an image.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAuthorizedAdmin } from '../lib/http.js';
import { stripTags } from '../lib/sanitize.js';

/**
 * SVG is deliberately excluded. An SVG is a document that can carry script, and
 * it would be served from our own CDN origin — uploading one would be a stored
 * XSS with a same-origin blast radius.
 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_BYTES = 10 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 300;

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET ?? '';
const CDN_BASE = process.env.MEDIA_CDN_BASE ?? '';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const mediaId = event.pathParameters?.mediaId;

  try {
    if (path.endsWith('/upload-url')) return createUploadUrl(parseBody(event));
    if (mediaId) {
      if (method === 'PATCH') return update(mediaId, parseBody(event));
      if (method === 'DELETE') return remove(mediaId);
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'POST') return confirm(parseBody(event));
    return list(event.queryStringParameters?.q);
  } catch (err) {
    return serverError('adminMedia', err);
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
    return {};
  }
}

async function list(query?: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  let request = supabase
    .from('media_assets')
    .select('id, url, filename, content_type, bytes, width, height, alt, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (query) request = request.ilike('filename', `%${query}%`);

  const { data, error } = await request;
  if (error) throw error;
  return ok({ media: data ?? [] });
}

async function createUploadUrl(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const filename = String(body.filename ?? '').trim();
  const contentType = String(body.contentType ?? '').trim().toLowerCase();
  const bytes = Number(body.bytes ?? 0);

  if (!filename) return badRequest('filename is required');
  if (!ALLOWED_TYPES.has(contentType)) {
    return badRequest(`Unsupported image type "${contentType}". Allowed: JPEG, PNG, WebP, GIF, AVIF.`);
  }
  if (!Number.isFinite(bytes) || bytes <= 0) return badRequest('bytes is required');
  if (bytes > MAX_BYTES) return badRequest(`Images must be ${MAX_BYTES / 1024 / 1024} MB or smaller`);
  if (!BUCKET || !CDN_BASE) return serverError('adminMedia.createUploadUrl', new Error('media env not configured'));

  // The original name is kept only as a readable suffix; the UUID is what makes
  // the key unique, so two uploads of "hero.jpg" cannot overwrite each other.
  const safeName = filename.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-60);
  const now = new Date();
  const key = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}-${safeName}`;

  // ContentType and ContentLength are bound into the signature, so the returned
  // URL cannot be reused to upload a different type or a much larger file.
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ContentLength: bytes }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return ok({ uploadUrl: url, key, publicUrl: `${CDN_BASE}/${key}`, contentType });
}

async function confirm(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const key = String(body.key ?? '');
  const filename = String(body.filename ?? '').trim() || key.split('/').pop() || 'image';
  if (!key.startsWith('media/')) return badRequest('key is not a media object');

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    return badRequest('That upload did not complete — the object is not in the bucket');
  }

  const contentType = (head.ContentType ?? '').toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    // Belt and braces: the presign bound the type, but the row must not record
    // something the library would then render as an image.
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return badRequest(`Uploaded object has type "${contentType}", which is not an allowed image type`);
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('media_assets')
    .insert({
      key,
      url: `${CDN_BASE}/${key}`,
      filename: stripTags(filename).slice(0, 200),
      content_type: contentType,
      bytes: head.ContentLength ?? null,
      // Dimensions are measured in the browser before upload; S3 does not know them.
      width: Number.isFinite(Number(body.width)) ? Number(body.width) : null,
      height: Number.isFinite(Number(body.height)) ? Number(body.height) : null,
      alt: body.alt ? stripTags(String(body.alt)).slice(0, 500) : null,
    })
    .select('id, url, filename, content_type, bytes, width, height, alt, created_at')
    .maybeSingle();

  if (error) throw error;
  return ok({ media: data });
}

async function update(mediaId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('media_assets')
    .update({ alt: body.alt === null ? null : stripTags(String(body.alt ?? '')).slice(0, 500) })
    .eq('id', mediaId)
    .select('id, url, filename, content_type, bytes, width, height, alt, created_at')
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Image not found');
  return ok({ media: data });
}

async function remove(mediaId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data: asset, error: readError } = await supabase
    .from('media_assets')
    .select('id, key')
    .eq('id', mediaId)
    .maybeSingle();

  if (readError) throw readError;
  if (!asset) return notFound('Image not found');

  // Deleting an image that a live page renders would break that page silently,
  // so say which pages use it and let the admin decide.
  const users = await pagesUsingMedia(mediaId);
  if (users.length) {
    return json(409, {
      error: `That image is still used by: ${users.join(', ')}. Remove it from those pages first.`,
      pages: users,
    });
  }

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: asset.key })).catch((err: unknown) => {
    // A missing object should not block cleaning up the row it points at.
    console.warn('[adminMedia.remove] S3 delete failed', err);
  });

  const { error } = await supabase.from('media_assets').delete().eq('id', mediaId);
  if (error) throw error;
  return ok({ deleted: true });
}

/** Substring match over the stored block JSON — media ids are UUIDs, so a false
 *  positive is not a practical concern, and erring toward "still in use" is the
 *  safe direction for a destructive action. */
async function pagesUsingMedia(mediaId: string): Promise<string[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('pages').select('slug, draft_blocks, published_blocks');
  if (error || !data) return [];

  return data
    .filter((page) => JSON.stringify([page.draft_blocks, page.published_blocks]).includes(mediaId))
    .map((page) => page.slug);
}

/**
 * Applicant file uploads: a profile photo, and a credential document.
 *
 *   POST /facilitator/upload-url   — presigned PUT
 *   POST /facilitator/upload       — confirm the object landed
 *
 * ## Why this is not `admin-media.ts`
 *
 * That handler is gated on `isAuthorizedAdmin` and accepts images only. An
 * applicant holds neither an admin key nor an admin-group token, and one of
 * the two files they submit is a PDF. Reusing it would have meant loosening
 * its auth — which is the single check standing between the public and the
 * whole media library, including delete.
 *
 * So this is a second, deliberately smaller door: any signed-in user, two
 * fixed destinations, no listing, no delete, no overwrite.
 *
 * ## The two kinds are not the same file in two folders
 *
 *   photo       → the CMS media bucket, a media_assets row, served from the
 *                 public CloudFront distribution. It is a headshot; it is
 *                 meant to be seen.
 *
 *   certificate → a separate, private bucket with no distribution in front of
 *                 it, no media_assets row, and no public URL anywhere. It is
 *                 somebody's diploma or professional licence, carrying their
 *                 full legal name.
 *
 * The separate bucket is load-bearing rather than tidy-minded. `MediaBucket`
 * sits behind a CloudFront distribution whose *default behaviour* covers the
 * entire bucket, so every object in it is fetchable by anyone holding the key
 * — a "private/" prefix there would be private in name only. Admin reads a
 * certificate through a short-lived signed URL instead (see admin-facilitators).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, unauthorized, serverError, notFound } from '../lib/http.js';
import { requireUser, UnauthorizedError } from '../lib/auth.js';
import { stripTags } from '../lib/sanitize.js';
import { CERT_PREFIX } from '../lib/facilitator-input.js';

/** SVG excluded for the same reason as the media library: it can carry script. */
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * PDF only.
 *
 * Images were considered — people photograph certificates — and rejected: an
 * image of a document still has to be read by a human, and allowing a second
 * type here doubles the content-type surface on the one endpoint that accepts
 * files from anyone with an account. A phone can export a photo to PDF.
 */
const CERT_TYPES = new Set(['application/pdf']);
const CERT_MAX_BYTES = 10 * 1024 * 1024;

const PRESIGN_TTL_SECONDS = 300;
const PHOTO_PREFIX = 'media/';

const s3 = new S3Client({});
const MEDIA_BUCKET = process.env.MEDIA_BUCKET ?? '';
const MEDIA_CDN_BASE = process.env.MEDIA_CDN_BASE ?? '';
/** No CloudFront distribution in front of this one. That is the point. */
const DOCS_BUCKET = process.env.FACILITATOR_DOCS_BUCKET ?? '';

interface KindConfig {
  bucket: string;
  prefix: string;
  types: Set<string>;
  maxBytes: number;
  /** Public photos get a media_assets row; private documents do not. */
  public: boolean;
}

function configFor(kind: unknown): KindConfig | null {
  if (kind === 'photo') {
    return {
      bucket: MEDIA_BUCKET,
      prefix: PHOTO_PREFIX,
      types: PHOTO_TYPES,
      maxBytes: PHOTO_MAX_BYTES,
      public: true,
    };
  }
  if (kind === 'certificate') {
    return {
      bucket: DOCS_BUCKET,
      prefix: CERT_PREFIX,
      types: CERT_TYPES,
      maxBytes: CERT_MAX_BYTES,
      public: false,
    };
  }
  return null;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let user;
  try {
    user = await requireUser(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('facilitatorUploads.auth', err);
  }

  const path = event.requestContext.http.path;
  if (event.requestContext.http.method !== 'POST') return badRequest('Unsupported method');

  // Awaited rather than returned bare, so an inner throw reaches the catch
  // below instead of Lambda — see the identical note in admin-facilitators.ts.
  try {
    if (path.endsWith('/upload-url')) return await createUploadUrl(user, parseBody(event));
    if (path.endsWith('/upload')) return await confirm(parseBody(event));
    return notFound();
  } catch (err) {
    return serverError('facilitatorUploads', err);
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

async function createUploadUrl(
  user: { sub: string },
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const config = configFor(body.kind);
  if (!config) return badRequest('kind must be "photo" or "certificate"');
  if (!config.bucket) {
    return serverError('facilitatorUploads.createUploadUrl', new Error('upload env not configured'));
  }

  const filename = String(body.filename ?? '').trim();
  const contentType = String(body.contentType ?? '').trim().toLowerCase();
  const bytes = Number(body.bytes ?? 0);

  if (!filename) return badRequest('filename is required');
  if (!config.types.has(contentType)) {
    return badRequest(
      body.kind === 'photo'
        ? `Unsupported image type "${contentType}". Allowed: JPEG, PNG, WebP, AVIF.`
        : 'The certification document must be a PDF.',
    );
  }
  if (!Number.isFinite(bytes) || bytes <= 0) return badRequest('bytes is required');
  if (bytes > config.maxBytes) {
    return badRequest(`That file must be ${config.maxBytes / 1024 / 1024} MB or smaller`);
  }

  // The original name survives only as a readable suffix; the UUID is what
  // makes the key unique, so two people uploading "certificate.pdf" cannot
  // overwrite each other. The uploader's `sub` is in the path of private
  // documents so an object can be traced back to an account without a database
  // lookup — useful exactly when something has gone wrong.
  const safeName = filename.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-60);
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = config.public
    ? `${config.prefix}${folder}/${randomUUID()}-${safeName}`
    : `${config.prefix}${user.sub}/${randomUUID()}-${safeName}`;

  // ContentType and ContentLength are bound into the signature, so the URL
  // cannot be reused to upload a different type or a much larger file.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
    }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return ok({
    uploadUrl,
    key,
    // Null for a certificate, and deliberately so: there is no public URL for
    // one, and returning something URL-shaped would invite a caller to render
    // it as a link.
    publicUrl: config.public ? `${MEDIA_CDN_BASE}/${key}` : null,
    contentType,
  });
}

/**
 * Confirms the object actually landed, and for a photo creates its library row.
 *
 * HeadObject rather than trusting the browser's word, same as
 * `admin-media.ts`: a client that says "uploaded" is describing something it
 * cannot actually observe, and a row pointing at a missing object breaks
 * silently and much later.
 */
async function confirm(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const config = configFor(body.kind);
  if (!config) return badRequest('kind must be "photo" or "certificate"');

  const key = String(body.key ?? '');
  // Pins the object to the prefix this kind owns, so a confirmed key cannot be
  // pointed at an arbitrary object elsewhere in the bucket.
  if (!key.startsWith(config.prefix) || key.includes('..')) {
    return badRequest('key is not a valid upload reference');
  }

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch {
    return badRequest('That upload did not complete — the object is not in the bucket');
  }

  const contentType = (head.ContentType ?? '').toLowerCase();
  if (!config.types.has(contentType)) {
    // Belt and braces with the presign, which already bound the type: the row
    // must never record something that would then be rendered as an image.
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    return badRequest(`Uploaded file has type "${contentType}", which is not allowed here`);
  }

  const filename = stripTags(String(body.filename ?? '')).trim().slice(0, 200)
    || key.split('/').pop()
    || 'upload';

  // A certificate gets no row of its own. It is referenced by
  // `facilitators.cert_document_key`, written when the application is
  // submitted — so an abandoned application leaves an orphaned object rather
  // than a dangling record, which is the cheaper of the two to clean up.
  if (!config.public) return ok({ mediaId: null, url: null, key, filename });

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('media_assets')
    .insert({
      key,
      url: `${MEDIA_CDN_BASE}/${key}`,
      filename,
      content_type: contentType,
      bytes: head.ContentLength ?? null,
      alt: filename,
    })
    .select('id, url')
    .maybeSingle<{ id: string; url: string }>();

  if (error) throw error;
  return ok({ mediaId: data?.id ?? null, url: data?.url ?? null, key, filename });
}

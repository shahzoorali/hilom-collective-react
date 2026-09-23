/**
 * Browser-side image compression, run *before* an upload is presigned.
 *
 * Both upload paths (admin media, facilitator photo) are presign → PUT
 * straight to S3 → confirm, so no Lambda ever sees the bytes and there is no
 * server-side place to shrink them. The browser is the only point in the
 * pipeline that holds the pixels, so that is where this runs. It also has to
 * run *before* `/upload-url`, because the presign binds ContentType and
 * ContentLength into the signature — compressing afterwards would produce a
 * blob S3 then refuses.
 *
 * The real problem this solves is format, not dimensions. The heavy assets in
 * the library are photos saved as PNG (a 1080×1350 PNG at 2.8 MB re-encodes to
 * roughly 150 KB of WebP) and phone JPEGs straight off a camera roll. Nothing
 * uploaded so far has been wider than 2400px, so the resize below is a
 * backstop rather than the main saving.
 *
 * ## What it deliberately does not touch
 *
 *  - **GIFs.** Canvas holds one frame, so re-encoding an animated GIF would
 *    silently throw away the animation. A 3 MB GIF is better than a broken one.
 *  - **Anything it cannot decode.** `createImageBitmap` throwing means we hand
 *    back the original file and let the existing size limit reject it if it is
 *    too big. A failed optimisation must never become a failed upload.
 *  - **Results that came out bigger.** Small PNGs (flat colour, logos, screen-
 *    shots) often beat WebP. If the re-encode is not a real improvement, the
 *    original is kept.
 *
 * Transparency survives: WebP has an alpha channel, so a logo on a transparent
 * background stays transparent. EXIF orientation is applied during decode via
 * `imageOrientation: 'from-image'`, so portrait phone photos stay upright —
 * the rotation metadata does not survive the re-encode, so it has to be baked
 * into the pixels here.
 */

export interface CompressOptions {
  /** Longest edge, in pixels. Larger images are scaled down proportionally. */
  maxDimension?: number;
  /** WebP quality, 0–1. */
  quality?: number;
  /** Files at or under this size are left alone. */
  skipUnderBytes?: number;
}

export interface CompressResult {
  file: File;
  /** Size before compression, for the "saved 94%" message. */
  originalBytes: number;
  /** True when the returned file is the original, untouched. */
  unchanged: boolean;
  /** Why it was left alone — for logging, not for the operator. */
  reason?: 'not-an-image' | 'animated' | 'undecodable' | 'no-gain' | 'already-small';
  width?: number;
  height?: number;
}

const DEFAULTS: Required<CompressOptions> = {
  maxDimension: 2400,
  quality: 0.82,
  // Below this, the network round trip costs more than the bytes saved.
  skipUnderBytes: 150 * 1024,
};

/** Re-encoding an animated GIF would keep one frame and drop the animation. */
const NEVER_TOUCH = new Set(['image/gif']);

const swapExtension = (name: string) => `${name.replace(/\.[^./\\]+$/, '') || 'image'}.webp`;

/**
 * Returns a compressed WebP copy of `file`, or the original when compressing
 * it would be wrong or pointless. Never throws: every failure path falls back
 * to the original file, because a broken optimisation must not block an upload.
 */
export async function compressImage(file: File, options: CompressOptions = {}): Promise<CompressResult> {
  const { maxDimension, quality, skipUnderBytes } = { ...DEFAULTS, ...options };
  const originalBytes = file.size;
  const keep = (reason: CompressResult['reason']): CompressResult => ({
    file,
    originalBytes,
    unchanged: true,
    reason,
  });

  if (!file.type.startsWith('image/')) return keep('not-an-image');
  if (NEVER_TOUCH.has(file.type)) return keep('animated');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return keep('undecodable');
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    // A small file that also needs no resizing is already fine. Checked after
    // decoding so the caller still gets real dimensions back for the library row.
    if (originalBytes <= skipUnderBytes && scale === 1) {
      return { file, originalBytes, unchanged: true, reason: 'already-small', width, height };
    }

    const blob = await encode(bitmap, width, height, quality);
    if (!blob) return keep('undecodable');

    // Flat-colour PNGs and logos routinely beat WebP. Only take the re-encode
    // when it is a real win, so we never make a file bigger to "optimise" it.
    if (blob.size >= originalBytes * 0.9) {
      return { file, originalBytes, unchanged: true, reason: 'no-gain', width, height };
    }

    const compressed = new File([blob], swapExtension(file.name), {
      type: 'image/webp',
      lastModified: file.lastModified,
    });
    return { file: compressed, originalBytes, unchanged: false, width, height };
  } catch {
    return keep('undecodable');
  } finally {
    bitmap.close();
  }
}

/** Draws to an OffscreenCanvas where available, falling back to a DOM canvas. */
async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

/** "2.8 MB → 143 KB (95% smaller)", for the upload confirmation. */
export function describeSaving(originalBytes: number, newBytes: number): string {
  const pct = Math.round((1 - newBytes / originalBytes) * 100);
  return `${formatBytes(originalBytes)} → ${formatBytes(newBytes)} (${pct}% smaller)`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

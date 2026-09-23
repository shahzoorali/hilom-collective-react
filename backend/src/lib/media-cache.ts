/**
 * The `Cache-Control` every publicly-served upload is stored with.
 *
 * Both upload paths mint keys containing a UUID, so an object's bytes never
 * change once written and a year of browser and CloudFront caching is safe.
 * Set on the object rather than on the distribution so the header travels with
 * the bytes — CloudFront passes the origin's header straight through, and with
 * no header at all the browser revalidates the whole media library on every
 * repeat visit. `scripts/compress-media.ts` writes the same value when it
 * rewrites an object, so backfilled and freshly-uploaded objects agree.
 *
 * Private objects (facilitator certificates) are deliberately excluded: they
 * are reached through short-lived signed URLs, and telling a browser to keep
 * one for a year is the wrong instinct.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

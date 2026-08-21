/**
 * Page slug rules.
 *
 * The frontend serves CMS pages from a catch-all route that sits *below* the
 * hardcoded routes, so a CMS page named `courses` could never be reached — it
 * would silently lose to the real catalog page. Rejecting those slugs at write
 * time turns a confusing invisible page into an error message.
 */
export const RESERVED_SLUGS = new Set([
  'courses',
  'checkout',
  'auth',
  'admin',
  'blog',
  'products',
  'orders',
  'webhooks',
  'community-submit',
]);

export class SlugError extends Error {}

/** Home is 'home'; everything else is `kebab-case`. */
export function normalizeSlug(raw: unknown): string {
  if (typeof raw !== 'string') throw new SlugError('slug must be a string');

  const slug = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (slug === '') throw new SlugError('slug is required');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new SlugError('slug must be lowercase letters, digits, and single hyphens');
  }
  if (slug.length > 80) throw new SlugError('slug is too long');
  if (RESERVED_SLUGS.has(slug)) {
    throw new SlugError(`"${slug}" is reserved by a built-in page and cannot be used`);
  }
  return slug;
}

/** Turns a page title into a starting slug suggestion. */
export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Finds a slug that doesn't collide, trying `base`, then `base-2`, `base-3`,
 * ... — used by "Duplicate" so a copy never fails on the unique constraint.
 * `exists` is caller-supplied so this file stays free of any DB dependency;
 * the 80-char cap matches `normalizeSlug`'s, enforced here too since a
 * collision suffix can push a max-length base over it.
 */
export async function findAvailableSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  let candidate = base.slice(0, 80);
  for (let n = 2; await exists(candidate); n++) {
    const suffix = `-${n}`;
    candidate = base.slice(0, 80 - suffix.length) + suffix;
    if (n > 500) throw new SlugError('Could not find an available slug for the duplicate');
  }
  return candidate;
}

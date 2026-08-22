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
  // Facilitator marketplace routes. Same hazard as `courses`: these sit above
  // the CMS catch-all in App.tsx, so a page created at one of these slugs would
  // be silently unreachable.
  'facilitators',
  'facilitator',
  'book',
  'booking',
  'bookings',
  'account',
]);

/**
 * Slugs a facilitator profile must never occupy.
 *
 * Deliberately separate from RESERVED_SLUGS above, which guards the *CMS page*
 * namespace (`/:slug`). This guards the *facilitator* namespace
 * (`/facilitators/:slug`), whose only collision is the static
 * `/facilitators/apply` route sitting above it in App.tsx — a facilitator who
 * landed on this slug would have a permanently unreachable public profile and
 * no error anywhere to explain why. A CMS page at `/apply` is still perfectly
 * legal, which is exactly why this is not merged into the set above.
 */
export const FACILITATOR_RESERVED_SLUGS = new Set(['apply']);

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

/**
 * `findAvailableSlug` for facilitator profiles, with the reserved names above
 * folded in as "already taken".
 *
 * Taken rather than rejected on purpose: an applicant whose display name
 * happens to slugify to a reserved word gets `apply-2` and a working profile,
 * instead of an application that fails on a rule they cannot see. Shared by
 * the self-service application and the admin's direct-add path so the two
 * cannot drift — they previously duplicated this call.
 */
export async function findAvailableFacilitatorSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  return findAvailableSlug(
    base,
    async (candidate) => FACILITATOR_RESERVED_SLUGS.has(candidate) || (await exists(candidate)),
  );
}

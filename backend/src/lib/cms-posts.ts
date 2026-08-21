/**
 * Validation for blog post and category records.
 *
 * Follows the same pattern as cms-events.ts: a small validator for structured
 * table data, reusing sanitizeRichText/stripTags from sanitize.ts and
 * validateBlocks from cms-blocks.ts.
 */
import { sanitizeRichText, stripTags } from './sanitize.js';
import { validateBlocks, BlockValidationError } from './cms-blocks.js';
import { normalizeSlug, slugify, SlugError } from './slug.js';

// ---------------------------------------------------------------------------
// Post validation
// ---------------------------------------------------------------------------

export interface PostInput {
  title: string;
  slug: string;
  excerpt: string | null;
  image_id: string | null;
  image_url: string | null;
  image_alt: string | null;
  author_name: string | null;
  author_image_url: string | null;
  category_id: string | null;
  tags: string[];
  seo_title: string | null;
  seo_description: string | null;
}

function optionalText(raw: unknown, maxLength: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BlockValidationError('expected a string');
  return stripTags(raw).slice(0, maxLength);
}

function optionalUrl(raw: unknown, field: string): string | null {
  const value = optionalText(raw, 2000);
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    throw new BlockValidationError(`${field} must be an http or https URL`);
  }
  return value;
}

export function validatePost(body: Record<string, unknown>): PostInput {
  const title = stripTags(String(body.title ?? '')).trim();
  if (!title) throw new BlockValidationError('title is required');

  // Slug: use provided or derive from title.
  const slug = normalizeSlug(body.slug ? body.slug : slugify(title));

  // Image travels as one {id, url, alt} object, same as events.
  const image = body.image as { id?: unknown; url?: unknown; alt?: unknown } | undefined;
  const hasImage = image && typeof image === 'object' && typeof image.url === 'string' && image.url;

  // Tags: flat string array, sanitized.
  let tags: string[] = [];
  if (Array.isArray(body.tags)) {
    tags = body.tags
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map((t) => stripTags(t.trim().toLowerCase()).slice(0, 50))
      .slice(0, 20); // cap at 20 tags
  }

  return {
    title: title.slice(0, 200),
    slug,
    excerpt: optionalText(body.excerpt, 500),
    image_id: hasImage && typeof image!.id === 'string' ? image!.id : null,
    image_url: hasImage ? String(image!.url) : null,
    image_alt: hasImage ? stripTags(String(image!.alt ?? '')).slice(0, 500) : null,
    author_name: optionalText(body.author_name, 100),
    author_image_url: optionalUrl(body.author_image_url, 'author_image_url'),
    category_id: typeof body.category_id === 'string' && body.category_id ? body.category_id : null,
    tags,
    seo_title: optionalText(body.seo_title, 120),
    seo_description: optionalText(body.seo_description, 300),
  };
}

// ---------------------------------------------------------------------------
// Category validation
// ---------------------------------------------------------------------------

export interface CategoryInput {
  slug: string;
  name: string;
  description: string | null;
  position: number;
}

export function validateCategory(body: Record<string, unknown>): CategoryInput {
  const name = stripTags(String(body.name ?? '')).trim();
  if (!name) throw new BlockValidationError('name is required');

  const slug = normalizeSlug(body.slug ? body.slug : slugify(name));

  return {
    slug,
    name: name.slice(0, 100),
    description: optionalText(body.description, 500),
    position: typeof body.position === 'number' ? Math.round(body.position) : 0,
  };
}

export { validateBlocks, BlockValidationError, SlugError };

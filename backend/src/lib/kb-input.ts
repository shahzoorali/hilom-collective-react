/**
 * Validation for knowledge-base categories and articles.
 *
 * Follows cms-posts.ts: a small validator per table, reusing stripTags from
 * sanitize.ts and normalizeSlug/slugify from slug.ts.
 *
 * The one thing this file does that the other validators do not is leave the
 * article **body** alone. Everywhere else in the CMS, free text is run through
 * `stripTags`, because everywhere else free text lands in a heading or a
 * caption where markup is only ever a mistake. A KB body is markdown, and
 * markdown legitimately contains characters `stripTags` mangles. Stripping it
 * here would quietly corrupt articles; the body is instead rendered through a
 * markdown renderer with HTML disabled at read time, which is where that
 * decision belongs. Every *other* field on the article is a title, a summary or
 * a label, and all of them are stripped.
 */
import { stripTags } from './sanitize.js';
import { normalizeSlug, slugify, SlugError } from './slug.js';

export class KbInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbInputError';
  }
}

/** Kept in step with public.kb_article_kind in 0037_knowledge_base.sql. */
export const ARTICLE_KINDS = ['guide', 'troubleshooting'] as const;
/** Kept in step with public.kb_audience in 0037_knowledge_base.sql. */
export const AUDIENCES = ['client', 'facilitator', 'both'] as const;

export type ArticleKind = (typeof ARTICLE_KINDS)[number];
export type Audience = (typeof AUDIENCES)[number];

const MAX_TITLE = 200;
const MAX_SUMMARY = 300;
const MAX_SEO_TITLE = 120;
const MAX_SEO_DESCRIPTION = 300;
const MAX_TAG = 50;
const MAX_TAGS = 20;

/**
 * 200 KB. Not a guess at how long an article should be — it is the point past
 * which someone is pasting something that is not an article, and an unbounded
 * text column reached through a public-ish admin endpoint is a cheap way to
 * fill a database.
 */
const MAX_BODY = 200_000;

function optionalText(raw: unknown, maxLength: number, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new KbInputError(`${field} must be a string`);
  const value = stripTags(raw).trim().slice(0, maxLength);
  return value === '' ? null : value;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = stripTags(entry).trim().toLowerCase().slice(0, MAX_TAG);
    // Deduplicated deliberately: tags drive the related-articles query
    // (`tags && tags`), and a duplicate would weight one article's overlap
    // higher than another's for no reason a reader could perceive.
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

function requireEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new KbInputError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

function normalizePosition(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new KbInputError('position must be a number');
  // Clamped rather than rejected: position is an ordering hint an editor drags
  // around, not an assertion worth failing a save over.
  return Math.max(0, Math.min(100_000, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CategoryInput {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  position: number;
}

export function validateCategory(body: Record<string, unknown>): CategoryInput {
  const name = stripTags(String(body.name ?? '')).trim();
  if (!name) throw new KbInputError('name is required');

  return {
    slug: normalizeSlug(body.slug ? body.slug : slugify(name)),
    name: name.slice(0, MAX_TITLE),
    description: optionalText(body.description, MAX_SUMMARY, 'description'),
    // An icon *key* the frontend resolves against a fixed set it ships, so the
    // charset is deliberately narrow — this value is used to pick a component,
    // and anything that is not a plain key is a bug or an attempt.
    icon: (() => {
      const icon = optionalText(body.icon, 40, 'icon');
      if (icon && !/^[a-z0-9-]+$/.test(icon)) {
        throw new KbInputError('icon must be lowercase letters, digits and hyphens');
      }
      return icon;
    })(),
    position: normalizePosition(body.position),
  };
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export interface ArticleInput {
  slug: string;
  category_id: string;
  title: string;
  summary: string | null;
  body: string;
  kind: ArticleKind;
  audience: Audience;
  position: number;
  tags: string[];
  seo_title: string | null;
  seo_description: string | null;
}

export function validateArticle(body: Record<string, unknown>): ArticleInput {
  const title = stripTags(String(body.title ?? '')).trim();
  if (!title) throw new KbInputError('title is required');

  // Required, unlike posts.category_id: kb_articles.category_id is NOT NULL,
  // because an uncategorised article is unreachable from the navigation while
  // still being live and indexable. Caught here so the failure is a readable
  // message rather than a 23502 from Postgres.
  const categoryId = body.category_id;
  if (typeof categoryId !== 'string' || !categoryId.trim()) {
    throw new KbInputError('category_id is required');
  }

  const rawBody = body.body === undefined || body.body === null ? '' : body.body;
  if (typeof rawBody !== 'string') throw new KbInputError('body must be a string');
  if (rawBody.length > MAX_BODY) {
    throw new KbInputError(`body is too long (max ${MAX_BODY} characters)`);
  }

  return {
    slug: normalizeSlug(body.slug ? body.slug : slugify(title)),
    category_id: categoryId.trim(),
    title: title.slice(0, MAX_TITLE),
    summary: optionalText(body.summary, MAX_SUMMARY, 'summary'),
    // Not stripped — see the note at the top of this file.
    body: rawBody,
    kind: requireEnum(body.kind, ARTICLE_KINDS, 'kind', 'guide'),
    audience: requireEnum(body.audience, AUDIENCES, 'audience', 'client'),
    position: normalizePosition(body.position),
    tags: normalizeTags(body.tags),
    seo_title: optionalText(body.seo_title, MAX_SEO_TITLE, 'seo_title'),
    seo_description: optionalText(body.seo_description, MAX_SEO_DESCRIPTION, 'seo_description'),
  };
}

/**
 * The same rules as `validateArticle`, applied only to the fields present.
 *
 * A PATCH that names three fields must not be forced to resend the title and
 * the body to satisfy the required checks — and, more importantly, must not
 * silently reset the fields it omits to their defaults, which is what running
 * the full validator over a partial body would do to `kind` and `audience`.
 */
export function validateArticlePatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = stripTags(String(body.title ?? '')).trim();
    if (!title) throw new KbInputError('title cannot be empty');
    patch.title = title.slice(0, MAX_TITLE);
  }
  if (body.slug !== undefined) patch.slug = normalizeSlug(body.slug);
  if (body.category_id !== undefined) {
    if (typeof body.category_id !== 'string' || !body.category_id.trim()) {
      throw new KbInputError('category_id cannot be empty');
    }
    patch.category_id = body.category_id.trim();
  }
  if (body.summary !== undefined) patch.summary = optionalText(body.summary, MAX_SUMMARY, 'summary');
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') throw new KbInputError('body must be a string');
    if (body.body.length > MAX_BODY) {
      throw new KbInputError(`body is too long (max ${MAX_BODY} characters)`);
    }
    patch.body = body.body;
  }
  if (body.kind !== undefined) patch.kind = requireEnum(body.kind, ARTICLE_KINDS, 'kind', 'guide');
  if (body.audience !== undefined) {
    patch.audience = requireEnum(body.audience, AUDIENCES, 'audience', 'client');
  }
  if (body.position !== undefined) patch.position = normalizePosition(body.position);
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (body.seo_title !== undefined) {
    patch.seo_title = optionalText(body.seo_title, MAX_SEO_TITLE, 'seo_title');
  }
  if (body.seo_description !== undefined) {
    patch.seo_description = optionalText(body.seo_description, MAX_SEO_DESCRIPTION, 'seo_description');
  }

  return patch;
}

export { SlugError };

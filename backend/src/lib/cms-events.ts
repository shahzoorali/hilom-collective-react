/**
 * Validation for event records — the write-side counterpart to the block
 * catalog in cms-blocks.ts, but events are a plain table rather than JSONB
 * block props, so they get their own small validator instead of a spec-driven
 * one.
 */
import { sanitizeRichText, stripTags } from './sanitize.js';
import { BlockValidationError } from './cms-blocks.js';

export interface EventInput {
  title: string;
  subtitle: string | null;
  description: string | null;
  image_id: string | null;
  image_url: string | null;
  image_alt: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  link_url: string | null;
  link_label: string | null;
  note: string | null;
}

function optionalText(raw: unknown, maxLength: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BlockValidationError('expected a string');
  return stripTags(raw).slice(0, maxLength);
}

function parseDate(raw: unknown, field: string): Date {
  if (typeof raw !== 'string' || !raw) throw new BlockValidationError(`${field} is required`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new BlockValidationError(`${field} is not a valid date`);
  return date;
}

/** Same scheme allowlist as block hrefs: no javascript:/data:. */
function optionalUrl(raw: unknown, field: string): string | null {
  const value = optionalText(raw, 1000);
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    throw new BlockValidationError(`${field} must be an http or https URL`);
  }
  return value;
}

export function validateEvent(body: Record<string, unknown>): EventInput {
  const title = stripTags(String(body.title ?? '')).trim();
  if (!title) throw new BlockValidationError('title is required');

  const startsAt = parseDate(body.starts_at, 'starts_at');
  let endsAt: Date | null = null;
  if (body.ends_at) {
    endsAt = parseDate(body.ends_at, 'ends_at');
    if (endsAt < startsAt) throw new BlockValidationError('ends_at cannot be before starts_at');
  }

  // image_id/url/alt travel together (the same MediaRef shape every media
  // field uses) or not at all — a stray id with no url is more likely a bug
  // than an event photo.
  const image = body.image as { id?: unknown; url?: unknown; alt?: unknown } | undefined;
  const hasImage = image && typeof image === 'object' && typeof image.url === 'string' && image.url;

  return {
    title: title.slice(0, 200),
    subtitle: optionalText(body.subtitle, 300),
    description: body.description ? sanitizeRichText(String(body.description).slice(0, 10000)) : null,
    image_id: hasImage && typeof image!.id === 'string' ? image!.id : null,
    image_url: hasImage ? String(image!.url) : null,
    image_alt: hasImage ? stripTags(String(image!.alt ?? '')).slice(0, 500) : null,
    location: optionalText(body.location, 300),
    starts_at: startsAt.toISOString(),
    ends_at: endsAt ? endsAt.toISOString() : null,
    link_url: optionalUrl(body.link_url, 'link_url'),
    link_label: optionalText(body.link_label, 100),
    note: optionalText(body.note, 300),
  };
}

/**
 * Validation for event records — the write-side counterpart to the block
 * catalog in cms-blocks.ts, but events are a plain table rather than JSONB
 * block props, so they get their own small validator instead of a spec-driven
 * one.
 */
import { sanitizeRichText, stripTags } from './sanitize.js';
import { BlockValidationError } from './cms-blocks.js';
import {
  REGISTRANT_FIELDS,
  isRegistrantField,
  startOfDayManila,
  endOfDayManila,
  type EventFormat,
} from './event-ticketing.js';

export interface Facilitator {
  name: string;
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  photo_alt: string | null;
}

export interface GalleryImage {
  url: string;
  alt: string;
}

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
  // Undefined — not [] — when the request body did not mention the key at
  // all, so a PUT from a form that knows nothing about these fields (the
  // plain event editor) cannot silently wipe a roster or a gallery someone
  // set through a different call. Object spread + JSON serialization drops an
  // undefined-valued key, so this reads as "field omitted from the patch" at
  // the database, exactly like validateTicketing's null-return does for the
  // ticketing block.
  facilitators: Facilitator[] | undefined;
  gallery: GalleryImage[] | undefined;
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

const MAX_FACILITATORS = 12;
const MAX_GALLERY = 20;

/** Same http(s)-only rule as optionalUrl, applied to a photo src. */
function photoUrl(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim().slice(0, 1000);
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    throw new BlockValidationError(`${field} must be an http or https URL`);
  }
  return value;
}

/**
 * A facilitator roster: name, role, a short bio, and a photo.
 *
 * Bio is plain text, not rich text — stripTags rather than sanitizeRichText —
 * because a bio is a paragraph, not a document; nobody needs headings or lists
 * inside three sentences about a facilitator, and keeping it plain avoids a
 * second HTML sanitization pass on content nobody asked to format.
 */
function validateFacilitators(raw: unknown): Facilitator[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new BlockValidationError('facilitators must be a list');
  if (raw.length > MAX_FACILITATORS) {
    throw new BlockValidationError(`facilitators: at most ${MAX_FACILITATORS} allowed`);
  }
  return raw.map((item, i) => {
    const f = (item ?? {}) as Record<string, unknown>;
    const name = stripTags(String(f.name ?? '')).trim().slice(0, 120);
    if (!name) throw new BlockValidationError(`facilitator ${i + 1} needs a name`);
    return {
      name,
      title: optionalText(f.title, 200),
      bio: optionalText(f.bio, 2000),
      photo_url: photoUrl(f.photo_url, `facilitator ${i + 1} photo`),
      photo_alt: optionalText(f.photo_alt, 300),
    };
  });
}

/** A set of venue/event photos, shown as a simple grid. */
function validateGallery(raw: unknown): GalleryImage[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new BlockValidationError('gallery must be a list');
  if (raw.length > MAX_GALLERY) {
    throw new BlockValidationError(`gallery: at most ${MAX_GALLERY} images allowed`);
  }
  return raw.map((item, i) => {
    const g = (item ?? {}) as Record<string, unknown>;
    const url = photoUrl(g.url, `gallery image ${i + 1}`);
    if (!url) throw new BlockValidationError(`gallery image ${i + 1} needs a url`);
    return { url, alt: stripTags(String(g.alt ?? '')).trim().slice(0, 300) };
  });
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
    facilitators: validateFacilitators(body.facilitators),
    gallery: validateGallery(body.gallery),
  };
}

// ---------------------------------------------------------------------------
// Ticketing
// ---------------------------------------------------------------------------
// Added by 0016. Every field is optional on the wire, and validateTicketing
// returns null when the body mentions none of them — which is what keeps the
// existing listing-only event editor working unchanged. A PUT from the old
// form must never switch ticketing on, off, or into a half-configured state.

export interface TicketingInput {
  ticketing_enabled: boolean;
  format: EventFormat | null;
  capacity: number | null;
  currency: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  hold_minutes: number;
  venue_details: string | null;
  terms_html: string | null;
  registrant_fields: string[];
}

const TICKETING_KEYS = [
  'ticketing_enabled',
  'format',
  'capacity',
  'registration_opens_at',
  'registration_closes_at',
  'hold_minutes',
  'venue_details',
  'terms_html',
  'registrant_fields',
] as const;

const FORMATS: EventFormat[] = ['residential', 'virtual', 'day'];

/** Same "a date means a Manila day" rule the payment schedule uses. */
function ticketingEdge(raw: unknown, edge: 'start' | 'end', field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return edge === 'start' ? startOfDayManila(value) : endOfDayManila(value);
    }
  } catch {
    throw new BlockValidationError(`${field} is not a valid date`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BlockValidationError(`${field} is not a valid date`);
  return parsed.toISOString();
}

/**
 * Validates the ticketing half of an event.
 *
 * Returns null when the body carries no ticketing fields at all, so that the
 * existing event form — which knows nothing about any of this — keeps working
 * and cannot accidentally clear a configured event's capacity by omission.
 *
 * The one rule worth stating: **ticketing on with no capacity is refused.** A
 * null capacity is not "unlimited"; it is always a half-finished form, and
 * `claim_event_seat` would reject every registration with
 * `capacity_not_configured` anyway. Better to say so while the admin is still
 * looking at the field.
 */
export function validateTicketing(body: Record<string, unknown>): TicketingInput | null {
  const mentioned = TICKETING_KEYS.some((k) => body[k] !== undefined);
  if (!mentioned) return null;

  const enabled = Boolean(body.ticketing_enabled);

  const rawFormat = body.format === undefined || body.format === null || body.format === ''
    ? null
    : String(body.format);
  if (rawFormat !== null && !FORMATS.includes(rawFormat as EventFormat)) {
    throw new BlockValidationError(`format must be one of ${FORMATS.join(', ')}`);
  }
  const format = rawFormat as EventFormat | null;

  let capacity: number | null = null;
  if (body.capacity !== undefined && body.capacity !== null && body.capacity !== '') {
    const n = Number(body.capacity);
    if (!Number.isInteger(n) || n < 1) {
      throw new BlockValidationError('capacity must be a whole number of seats, at least 1');
    }
    capacity = n;
  }

  let holdMinutes = 60;
  if (body.hold_minutes !== undefined && body.hold_minutes !== null && body.hold_minutes !== '') {
    const n = Number(body.hold_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) {
      throw new BlockValidationError('hold_minutes must be between 5 and 1440');
    }
    holdMinutes = n;
  }

  const opensAt = ticketingEdge(body.registration_opens_at, 'start', 'registration_opens_at');
  const closesAt = ticketingEdge(body.registration_closes_at, 'end', 'registration_closes_at');
  if (opensAt && closesAt && Date.parse(opensAt) > Date.parse(closesAt)) {
    throw new BlockValidationError('registration closes before it opens');
  }

  if (enabled) {
    if (capacity === null) {
      throw new BlockValidationError('A ticketed event needs a capacity — how many seats are for sale?');
    }
    if (format === null) {
      throw new BlockValidationError('A ticketed event needs a format: residential, virtual, or day.');
    }
  }

  // Unknown keys are dropped rather than rejected: the whitelist is closed
  // (see REGISTRANT_FIELDS), so anything else is a stale form, not an attack
  // surface, and failing the save would be the less useful response.
  const rawFields = Array.isArray(body.registrant_fields) ? body.registrant_fields : [];
  const registrantFields = [...new Set(rawFields.map(String).filter(isRegistrantField))];
  const unknown = rawFields.map(String).filter((f) => !isRegistrantField(f));
  if (unknown.length > 0 && rawFields.length === unknown.length) {
    throw new BlockValidationError(
      `None of those registrant fields exist. Available: ${REGISTRANT_FIELDS.join(', ')}`,
    );
  }

  return {
    ticketing_enabled: enabled,
    format,
    capacity,
    currency: String(body.currency ?? 'PHP').slice(0, 3).toUpperCase(),
    registration_opens_at: opensAt,
    registration_closes_at: closesAt,
    hold_minutes: holdMinutes,
    venue_details: optionalText(body.venue_details, 2000),
    terms_html: body.terms_html ? sanitizeRichText(String(body.terms_html).slice(0, 20000)) : null,
    registrant_fields: registrantFields,
  };
}

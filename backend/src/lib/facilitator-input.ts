/**
 * Validation for everything a facilitator or admin can write.
 *
 * Separate from the handlers for the same reason `cms-events.ts` is: the shapes
 * are written from two places (the facilitator's own dashboard and the admin
 * screens), and a rule enforced in only one of them is not enforced.
 *
 * Free text that ends up rendered as HTML goes through `sanitizeRichText`, the
 * same allowlist the CMS blocks use. A facilitator bio is user-authored content
 * displayed to the public, which is exactly the shape of a stored-XSS vector.
 */
import { sanitizeRichText, stripTags } from './sanitize.js';

export class FacilitatorInputError extends Error {}

function str(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new FacilitatorInputError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new FacilitatorInputError(`${field} must be text`);
  const trimmed = stripTags(value).trim();
  if (required && !trimmed) throw new FacilitatorInputError(`${field} is required`);
  if (trimmed.length > max) throw new FacilitatorInputError(`${field} is too long (max ${max})`);
  return trimmed || null;
}

function strList(value: unknown, field: string, maxItems = 20, maxLen = 120): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FacilitatorInputError(`${field} must be a list`);
  if (value.length > maxItems) throw new FacilitatorInputError(`${field} has too many entries`);
  return value
    .map((item) => (typeof item === 'string' ? stripTags(item).trim() : ''))
    .filter(Boolean)
    .map((item) => item.slice(0, maxLen));
}

function int(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new FacilitatorInputError(`${field} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new FacilitatorInputError(`${field} must be a whole number`);
  }
  if (n < min || n > max) throw new FacilitatorInputError(`${field} must be between ${min} and ${max}`);
  return n;
}

const DELIVERY_MODES = new Set(['online', 'in_person', 'both']);
/**
 * Every kind the `service_kind` enum knows about. `package` is present here
 * because the column, the profile page and the payout code all still
 * understand it — see SELLABLE_SERVICE_KINDS below for why it cannot
 * currently be sold.
 */
const SERVICE_KINDS = new Set(['exploratory', 'standard', 'package']);

/**
 * What a facilitator may actually put on sale today.
 *
 * `package` is deliberately excluded. The kind was fully modelled — validated
 * `sessions_count`, stored on the service, rendered on the profile as
 * "· 5 sessions" — but `POST /bookings` never read it: buying a package
 * charged the whole price and created exactly *one* booking, with no way to
 * schedule the rest. That is charging for sessions the system cannot deliver,
 * so the kind is closed at the point of sale rather than left available.
 *
 * Enforced here rather than only in the Services editor because a facilitator
 * holds a valid token and can POST to `/facilitator/services` directly; a
 * frontend-only gate would not actually close anything.
 *
 * To re-open it, the missing half is a purchase that grants N schedulable
 * credits rather than one booking. The decided shape (2026-08-23): the package
 * price is split across its N sessions and the facilitator earns each share as
 * that session is *delivered* — so payout logic keeps working unchanged, and an
 * abandoned package never pays out for sessions that did not happen. Nothing
 * needs migrating first: no package service or booking has ever existed in
 * production.
 */
const SELLABLE_SERVICE_KINDS = new Set(['exploratory', 'standard']);

/**
 * A meeting URL is emailed to clients as a link, so the scheme is checked
 * rather than assumed: `javascript:` in an href is a real hazard, and a link
 * that silently does nothing is worse than a rejected form.
 */
function url(value: unknown, field: string): string | null {
  const raw = str(value, field, 500);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FacilitatorInputError(`${field} must be a full URL including https://`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new FacilitatorInputError(`${field} must be an http or https URL`);
  }
  return parsed.toString();
}

/** Rejects a timezone the slot engine could not project rules into. */
function timezone(value: unknown): string {
  const raw = str(value, 'timezone', 60) ?? 'Asia/Manila';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    throw new FacilitatorInputError(`"${raw}" is not a recognised timezone`);
  }
  return raw;
}

export interface ProfileInput {
  display_name: string;
  headline: string | null;
  bio: string | null;
  photo_media_id: string | null;
  photo_url: string | null;
  credentials: string[];
  specialties: string[];
  languages: string[];
  location: string | null;
  delivery_mode: string;
  scope_note: string | null;
  social_links: Record<string, string>;
  timezone: string;
  vacation_until: string | null;
}

export function validateProfile(body: Record<string, unknown>): ProfileInput {
  const deliveryMode = typeof body.delivery_mode === 'string' ? body.delivery_mode : 'online';
  if (!DELIVERY_MODES.has(deliveryMode)) throw new FacilitatorInputError('Invalid delivery mode');

  const socialRaw = body.social_links;
  const social: Record<string, string> = {};
  if (socialRaw && typeof socialRaw === 'object' && !Array.isArray(socialRaw)) {
    for (const [key, value] of Object.entries(socialRaw as Record<string, unknown>)) {
      const link = url(value, `social_links.${key}`);
      if (link) social[key.slice(0, 40)] = link;
    }
  }

  let vacationUntil: string | null = null;
  if (body.vacation_until) {
    const parsed = new Date(String(body.vacation_until));
    if (Number.isNaN(parsed.getTime())) throw new FacilitatorInputError('vacation_until is not a date');
    vacationUntil = parsed.toISOString();
  }

  return {
    display_name: str(body.display_name, 'Name', 120, true)!,
    headline: str(body.headline, 'Headline', 200),
    // The one field allowed to keep markup — it is the long-form "my approach"
    // text, and the allowlist is the same one page rich-text blocks use.
    bio: typeof body.bio === 'string' && body.bio.trim() ? sanitizeRichText(body.bio) : null,
    photo_media_id: str(body.photo_media_id, 'Photo', 60),
    photo_url: url(body.photo_url, 'Photo URL'),
    credentials: strList(body.credentials, 'Credentials'),
    specialties: strList(body.specialties, 'Specialties'),
    languages: strList(body.languages, 'Languages', 10, 40),
    location: str(body.location, 'Location', 160),
    delivery_mode: deliveryMode,
    scope_note: str(body.scope_note, 'Scope of practice', 1000),
    social_links: social,
    timezone: timezone(body.timezone),
    vacation_until: vacationUntil,
  };
}

export interface ServiceInput {
  kind: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  price_centavos: number;
  currency: string;
  sessions_count: number;
  delivery_mode: string;
  meeting_url: string | null;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  max_per_day: number | null;
  cancellation_policy: string | null;
  is_active: boolean;
  sort_order: number;
}

export function validateService(body: Record<string, unknown>): ServiceInput {
  const kind = typeof body.kind === 'string' ? body.kind : 'standard';
  if (!SERVICE_KINDS.has(kind)) throw new FacilitatorInputError('Invalid service kind');
  if (!SELLABLE_SERVICE_KINDS.has(kind)) {
    // Said plainly rather than as "invalid": the kind is real and is coming
    // back, and a facilitator who set one up should know why it stopped.
    throw new FacilitatorInputError(
      'Multi-session packages are not available yet — sell the sessions individually for now.',
    );
  }

  const deliveryMode = typeof body.delivery_mode === 'string' ? body.delivery_mode : 'online';
  if (!DELIVERY_MODES.has(deliveryMode)) throw new FacilitatorInputError('Invalid delivery mode');

  // The free call has to actually be free. Without this the "one per client"
  // limit would be attached to something chargeable, which is not what any of
  // the copy on the site promises.
  const price = kind === 'exploratory' ? 0 : int(body.price_centavos, 'Price', 0, 100_000_000, 0);

  return {
    kind,
    title: str(body.title, 'Title', 160, true)!,
    description: typeof body.description === 'string' && body.description.trim()
      ? sanitizeRichText(body.description)
      : null,
    duration_minutes: int(body.duration_minutes, 'Duration', 5, 480),
    price_centavos: price,
    currency: str(body.currency, 'Currency', 3) ?? 'PHP',
    sessions_count: kind === 'package' ? int(body.sessions_count, 'Sessions', 1, 50, 1) : 1,
    delivery_mode: deliveryMode,
    meeting_url: url(body.meeting_url, 'Meeting link'),
    buffer_minutes: int(body.buffer_minutes, 'Buffer', 0, 240, 0),
    min_notice_minutes: int(body.min_notice_minutes, 'Minimum notice', 0, 43_200, 720),
    max_advance_days: int(body.max_advance_days, 'Booking window', 1, 365, 60),
    max_per_day:
      body.max_per_day === undefined || body.max_per_day === null || body.max_per_day === ''
        ? null
        : int(body.max_per_day, 'Maximum per day', 1, 24),
    cancellation_policy: str(body.cancellation_policy, 'Cancellation policy', 1000),
    is_active: body.is_active !== false,
    sort_order: int(body.sort_order, 'Order', 0, 999, 0),
  };
}

export interface AvailabilityInput {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

/**
 * Validates the whole weekly grid at once, because it is saved as a whole:
 * the dashboard replaces every window for the facilitator in one call rather
 * than diffing rows.
 *
 * Overlapping windows on the same day are rejected rather than merged. Merging
 * would silently rewrite what the facilitator typed, and the slot engine steps
 * through each window independently — two overlapping windows would generate
 * duplicate, subtly offset slots.
 */
export function validateAvailability(body: Record<string, unknown>): AvailabilityInput[] {
  const raw = body.windows;
  if (!Array.isArray(raw)) throw new FacilitatorInputError('windows must be a list');
  if (raw.length > 100) throw new FacilitatorInputError('Too many availability windows');

  const windows = raw.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const weekday = int(item.weekday, 'Day', 0, 6);
    const start = int(item.start_minute, 'Start time', 0, 1439);
    const end = int(item.end_minute, 'End time', 1, 1440);
    if (end <= start) throw new FacilitatorInputError('Each window must end after it starts');
    return { weekday, start_minute: start, end_minute: end };
  });

  const byDay = new Map<number, AvailabilityInput[]>();
  for (const window of windows) {
    const day = byDay.get(window.weekday) ?? [];
    for (const other of day) {
      if (window.start_minute < other.end_minute && other.start_minute < window.end_minute) {
        throw new FacilitatorInputError('Availability windows on the same day cannot overlap');
      }
    }
    day.push(window);
    byDay.set(window.weekday, day);
  }

  return windows;
}

export interface BlackoutInput {
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export function validateBlackout(body: Record<string, unknown>): BlackoutInput {
  const start = new Date(String(body.starts_at ?? ''));
  const end = new Date(String(body.ends_at ?? ''));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new FacilitatorInputError('starts_at and ends_at must be ISO-8601 dates');
  }
  if (end <= start) throw new FacilitatorInputError('The blackout must end after it starts');
  return {
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    reason: str(body.reason, 'Reason', 200),
  };
}

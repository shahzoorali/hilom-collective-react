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
import { validateIntakeQuestions, IntakeError, type IntakeQuestion } from './intake.js';

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
const MEETING_PROVIDERS = new Set(['manual', 'google_meet', 'zoom']);
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
  website_url: string | null;
  years_experience: string | null;
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
      // `socialLink`, not `url`: the same field on the application form accepts
      // a bare "@handle" or a scheme-less "instagram.com/x". Validating it
      // strictly here would mean a value the apply form accepted could not be
      // re-saved from the dashboard without being retyped.
      const link = socialLink(value, `social_links.${key}`);
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
    // Both are collected by the application form and are public profile
    // fields. Editable here so they are not write-once at apply time — a
    // facilitator who changes their site or their handle must not have to ask
    // an admin to fix it.
    website_url: socialLink(body.website_url, 'Website'),
    years_experience: oneOf(body.years_experience, 'Years of experience', YEARS_EXPERIENCE, false),
    timezone: timezone(body.timezone),
    vacation_until: vacationUntil,
  };
}

// ---------------------------------------------------------------------------
// The application form
// ---------------------------------------------------------------------------
// `validateProfile` above and `validateApplication` below deliberately do not
// share a code path, because they no longer describe the same thing.
//
// The apply form used to write profile copy — credentials, specialties, scope
// of practice — so one validator served both. It now asks a triage question
// instead: what do you want to build, and how involved should Hilom be. The
// profile fields it dropped are collected later, by the facilitator, in the
// dashboard Profile tab, and are still validated by `validateProfile` there.
//
// Folding these back together would mean one function whose required fields
// depend on which caller it has, which is the shape that eventually lets an
// applicant write a field only an approved facilitator should be able to set.

const CONTACT_METHODS = new Set(['email', 'phone', 'instagram', 'whatsapp']);

const YEARS_EXPERIENCE = new Set(['under_1', '1_3', '3_5', '5_plus']);

/** The three service tracks from the marketing page. */
const SUPPORT_TRACKS = new Set(['design', 'build_launch', 'live_experiences']);

const PROGRAM_STATUSES = new Set([
  'existing_program_online',
  'idea_to_course',
  'workshop_live',
  'retreat',
  'scale_existing',
  'not_sure',
]);

const REFERRAL_SOURCES = new Set([
  'instagram',
  'friend_colleague',
  'hilom_facilitator',
  'event_workshop',
  'search',
  'other',
]);

/**
 * What the applicant agreed to, stamped server-side.
 *
 * Never taken from the request body: a consent record whose version the
 * consenting party chose is not evidence of anything. Bump this when the
 * privacy policy materially changes, so existing rows keep pointing at the
 * text those people actually read.
 */
export const PRIVACY_POLICY_VERSION = '2026-09-03';

/**
 * A social or website link, accepting what people actually type.
 *
 * `url()` above requires a scheme because it validates a *meeting link*, which
 * is emailed as an href and must not be `javascript:`. This field is typed by
 * hand into a form, and the first real application submitted
 * "www.instagram.com/holdingspace.ph" — no scheme, entirely reasonable, and
 * rejected outright by `url()`. A bare "@handle" is just as likely.
 *
 * So: bare handles are kept as-is for a human to interpret, anything
 * domain-shaped gets https:// prepended and is then validated properly. The
 * scheme allowlist still applies, so pasting a `javascript:` URI here fails.
 */
function socialLink(value: unknown, field: string): string | null {
  const raw = str(value, field, 300);
  if (!raw) return null;
  // A handle, not a link. Nothing to validate and nothing to linkify.
  if (raw.startsWith('@')) return raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return url(`https://${raw}`, field);
  return url(raw, field);
}

/** Validates one of the form's multi-selects against its allowlist. */
function slugList(value: unknown, field: string, allowed: Set<string>): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new FacilitatorInputError(`${field} must be a list`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new FacilitatorInputError(`${field} contains an unrecognised option`);
    }
    seen.add(item);
  }
  return [...seen];
}

function oneOf(value: unknown, field: string, allowed: Set<string>, required: boolean): string | null {
  const raw = str(value, field, 60, required);
  if (!raw) return null;
  if (!allowed.has(raw)) throw new FacilitatorInputError(`${field} is not a valid option`);
  return raw;
}

export interface ApplicationInput {
  display_name: string;
  bio: string | null;
  photo_media_id: string | null;
  photo_url: string | null;
  contact_method: string;
  phone: string | null;
  social_links: Record<string, string>;
  website_url: string | null;
  years_experience: string;
  support_needed: string[];
  program_status: string[];
  cert_document_key: string | null;
  cert_document_name: string | null;
  referral_source: string;
  referral_source_other: string | null;
  privacy_accepted_at: string;
  privacy_policy_version: string;
}

export function validateApplication(body: Record<string, unknown>): ApplicationInput {
  const contactMethod = oneOf(body.contact_method, 'Preferred method of contact', CONTACT_METHODS, true)!;

  const phone = str(body.phone, 'Phone', 40);
  // Only enforced when they asked to be reached somewhere that needs a number.
  // Requiring it unconditionally would be asking for a detail we have no use
  // for from every applicant who picked Email.
  if ((contactMethod === 'phone' || contactMethod === 'whatsapp') && !phone) {
    throw new FacilitatorInputError('A phone number is required for that contact method');
  }

  const social: Record<string, string> = {};
  const handle = socialLink(body.social_handle, 'Social media handle');
  if (handle) social.social = handle;

  const website = socialLink(body.website_url, 'Website');
  if (website) social.website = website;

  const instagram = contactMethod === 'instagram' ? handle : null;
  if (instagram && !social.social) social.social = instagram;
  if (contactMethod === 'instagram' && !handle) {
    throw new FacilitatorInputError('An Instagram handle is required for that contact method');
  }

  const programStatus = slugList(body.program_status, 'What you have right now', PROGRAM_STATUSES);
  if (programStatus.length === 0) {
    throw new FacilitatorInputError('Tell us what you have for your programs right now');
  }

  // Deliberately not required — see the note on the column in
  // 0023_facilitator_intake.sql. `not_sure` in the question above means "I
  // cannot pick a track", and a form that then demands one is a dead end.
  const supportNeeded = slugList(body.support_needed, 'Support needed', SUPPORT_TRACKS);

  const referralSource = oneOf(body.referral_source, 'How you heard about us', REFERRAL_SOURCES, true)!;
  const referralOther = str(body.referral_source_other, 'How you heard about us', 200);
  if (referralSource === 'other' && !referralOther) {
    throw new FacilitatorInputError('Tell us how you heard about Hilom Collective');
  }

  // Checked, never merely recorded: consent is the one field where trusting
  // the client's word for it defeats the entire purpose of collecting it.
  if (body.privacy_accepted !== true) {
    throw new FacilitatorInputError('You must agree to the privacy policy to apply');
  }

  return {
    display_name: str(body.display_name, 'Name', 120, true)!,
    // Same allowlist the profile bio and the CMS rich-text blocks use — this is
    // public-facing, user-authored copy, which is the textbook stored-XSS shape.
    bio: typeof body.bio === 'string' && body.bio.trim() ? sanitizeRichText(body.bio) : null,
    photo_media_id: str(body.photo_media_id, 'Photo', 60),
    photo_url: url(body.photo_url, 'Photo URL'),
    contact_method: contactMethod,
    phone,
    social_links: social,
    website_url: website,
    years_experience: oneOf(body.years_experience, 'How long you have been doing this work', YEARS_EXPERIENCE, true)!,
    support_needed: supportNeeded,
    program_status: programStatus,
    // The S3 key, handed back by the upload confirm step. Constrained to the
    // private prefix so this cannot be pointed at an arbitrary object.
    cert_document_key: certKey(body.cert_document_key),
    cert_document_name: str(body.cert_document_name, 'Document name', 200),
    referral_source: referralSource,
    referral_source_other: referralSource === 'other' ? referralOther : null,
    privacy_accepted_at: new Date().toISOString(),
    privacy_policy_version: PRIVACY_POLICY_VERSION,
  };
}

/** Where applicant credential documents live. Never served publicly. */
export const CERT_PREFIX = 'facilitator-docs/';

function certKey(value: unknown): string | null {
  const raw = str(value, 'Certification document', 300);
  if (!raw) return null;
  if (!raw.startsWith(CERT_PREFIX) || raw.includes('..')) {
    throw new FacilitatorInputError('That document reference is not valid');
  }
  return raw;
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
  meeting_provider: string;
  meeting_url: string | null;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  max_per_day: number | null;
  cancellation_policy: string | null;
  refund_full_hours: number;
  refund_half_hours: number;
  intake_questions: IntakeQuestion[];
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

  // Which video account creates the link. 'manual' keeps the old behaviour —
  // `meeting_url` is the link. For 'google_meet' / 'zoom', `meeting_url`
  // becomes an optional backup and Hilom creates a real meeting per booking.
  //
  // Not validated against the facilitator's *connected* accounts here: that is
  // a live check the dashboard does, and a facilitator disconnecting an
  // account should not retroactively make their saved services unsavable. A
  // provider with no connection just falls back to the backup link at booking
  // time, and the dashboard nudges them to reconnect.
  const meetingProvider = typeof body.meeting_provider === 'string' ? body.meeting_provider : 'manual';
  if (!MEETING_PROVIDERS.has(meetingProvider)) {
    throw new FacilitatorInputError('Invalid meeting provider');
  }

  // The free call has to actually be free. Without this the "one per client"
  // limit would be attached to something chargeable, which is not what any of
  // the copy on the site promises.
  const price = kind === 'exploratory' ? 0 : int(body.price_centavos, 'Price', 0, 100_000_000, 0);

  // The refund ladder the platform will actually apply (0027). Rejected rather
  // than silently re-ordered when the half threshold sits above the full one:
  // this is the facilitator writing their own policy, and quietly changing what
  // they typed is how the free-text version came to mean nothing. The database
  // has the same check, but a constraint violation reaches them as a 500.
  let intakeQuestions;
  try {
    intakeQuestions = validateIntakeQuestions(body.intake_questions);
  } catch (err) {
    throw new FacilitatorInputError(err instanceof IntakeError ? err.message : 'Invalid intake form');
  }

  const refundFullHours = int(body.refund_full_hours, 'Full-refund notice', 0, 720, 24);
  const refundHalfHours = int(body.refund_half_hours, 'Half-refund notice', 0, 720, 12);
  if (refundHalfHours > refundFullHours) {
    throw new FacilitatorInputError(
      'The half-refund notice period cannot be longer than the full-refund one.',
    );
  }

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
    meeting_provider: meetingProvider,
    meeting_url: url(body.meeting_url, 'Meeting link'),
    buffer_minutes: int(body.buffer_minutes, 'Buffer', 0, 240, 0),
    min_notice_minutes: int(body.min_notice_minutes, 'Minimum notice', 0, 43_200, 720),
    max_advance_days: int(body.max_advance_days, 'Booking window', 1, 365, 60),
    max_per_day:
      body.max_per_day === undefined || body.max_per_day === null || body.max_per_day === ''
        ? null
        : int(body.max_per_day, 'Maximum per day', 1, 24),
    cancellation_policy: str(body.cancellation_policy, 'Cancellation policy', 1000),
    refund_full_hours: refundFullHours,
    refund_half_hours: refundHalfHours,
    // Thrown as a FacilitatorInputError so the handler's existing catch turns
    // it into a 400 with the message, rather than a 500 the facilitator cannot
    // act on.
    intake_questions: intakeQuestions,
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

/**
 * API client for the facilitator marketplace.
 *
 * A separate file from `api.ts` and `cms.ts` only because both are already
 * long; the conventions are identical — `apiFetch` for the transport, one thin
 * arrow per endpoint, and auth attached per call rather than by an interceptor.
 *
 * Three credentials appear here, and they are not interchangeable:
 *   * nothing          — the public directory
 *   * a Cognito bearer — a client's own bookings, and a facilitator's dashboard
 *                        (the server distinguishes the two from the token's
 *                        `cognito:groups`, not from anything sent here)
 *   * `x-admin-key`    — the admin screens, matching the other admin tabs
 */
import { apiFetch } from './api';
import { idToken } from './auth';
import type {
  ContactMethod,
  ProgramStatus,
  ReferralSource,
  SupportTrack,
  YearsExperience,
} from './facilitator-intake';

/** The bearer header, or a thrown error that reads as a prompt to sign in. */
function authHeaders(): Record<string, string> {
  const token = idToken();
  if (!token) throw new Error('Sign in to continue');
  return { Authorization: `Bearer ${token}` };
}

function jsonAuthHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliveryMode = 'online' | 'in_person' | 'both';
export type ServiceKind = 'exploratory' | 'standard' | 'package';

export type FacilitatorStatus = 'applied' | 'approved' | 'published' | 'suspended' | 'rejected';

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled_by_client'
  | 'cancelled_by_facilitator'
  | 'completed'
  | 'no_show'
  | 'refunded';

export interface Facilitator {
  id: string;
  slug: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  photo_url: string | null;
  credentials: string[];
  specialties: string[];
  languages: string[];
  location: string | null;
  delivery_mode: DeliveryMode;
  scope_note: string | null;
  social_links: Record<string, string>;
  /** Collected on the application form; the only two intake fields shown publicly. */
  website_url: string | null;
  years_experience: YearsExperience | null;
  timezone: string;
  status: FacilitatorStatus;
}

/** Directory cards carry a "from ₱X" summary the profile does not need. */
export interface FacilitatorCard extends Facilitator {
  fromCentavos: number | null;
  hasFreeCall: boolean;
}

export interface FacilitatorService {
  id: string;
  facilitator_id: string;
  kind: ServiceKind;
  title: string;
  description: string | null;
  duration_minutes: number;
  price_centavos: number;
  currency: string;
  sessions_count: number;
  delivery_mode: DeliveryMode;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  max_per_day: number | null;
  cancellation_policy: string | null;
  is_active: boolean;
  sort_order: number;
  /** Present only on the facilitator's own view — never on a public profile. */
  meeting_url?: string | null;
}

export interface SlotOption {
  startsAt: string;
  endsAt: string;
}

export interface Booking {
  id: string;
  facilitator_id: string;
  service_id: string;
  service_kind: ServiceKind;
  client_email: string;
  client_name: string | null;
  client_notes: string | null;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  price_centavos: number;
  platform_fee_centavos: number;
  facilitator_net_centavos: number;
  currency: string;
  meeting_url: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  refund_centavos: number | null;
  created_at: string;
  facilitators?: { slug: string; display_name: string; photo_url: string | null; timezone: string } | null;
  facilitator_services?: { title: string; duration_minutes: number } | null;
}

// ---------------------------------------------------------------------------
// Public directory
// ---------------------------------------------------------------------------

export const listFacilitators = (specialty?: string) =>
  apiFetch<{ facilitators: FacilitatorCard[] }>(
    `/facilitators${specialty ? `?specialty=${encodeURIComponent(specialty)}` : ''}`,
  ).then((r) => r.facilitators);

export const getFacilitator = (slug: string) =>
  apiFetch<{ facilitator: Facilitator; services: FacilitatorService[] }>(
    `/facilitators/${encodeURIComponent(slug)}`,
  );

export const getAvailability = (slug: string, serviceId: string, from: Date, to: Date) =>
  apiFetch<{ timezone: string; durationMinutes: number; slots: SlotOption[] }>(
    `/facilitators/${encodeURIComponent(slug)}/availability` +
      `?serviceId=${encodeURIComponent(serviceId)}` +
      `&from=${encodeURIComponent(from.toISOString())}` +
      `&to=${encodeURIComponent(to.toISOString())}`,
  );

// ---------------------------------------------------------------------------
// Client bookings
// ---------------------------------------------------------------------------

export interface CreateBookingResult {
  bookingId: string;
  /** True for the complimentary call, which never touches PayMongo. */
  free: boolean;
  checkoutUrl?: string;
  amountCentavos?: number;
  currency?: string;
  serviceTitle?: string;
  startsAt?: string;
  status?: string;
}

/**
 * Takes the slot and, when the service is paid, opens a PayMongo session.
 *
 * Only three fields go up. Price, duration and the buyer's email are read
 * server-side from the database and the verified token — see the note at the
 * top of `backend/src/handlers/bookings.ts`.
 */
export const createBooking = (input: {
  facilitatorSlug: string;
  serviceId: string;
  startsAt: string;
  notes?: string;
}) =>
  apiFetch<CreateBookingResult>('/bookings', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(input),
  });

export interface BookingStatusResult {
  bookingId: string;
  status: BookingStatus;
  startsAt: string;
  meetingUrl: string | null;
  facilitatorName: string | null;
  timezone: string | null;
  serviceTitle: string | null;
}

export const getBookingStatus = (bookingId: string) =>
  apiFetch<BookingStatusResult>(`/bookings/${encodeURIComponent(bookingId)}/status`, {
    headers: authHeaders(),
  });

export const listMyBookings = () =>
  apiFetch<{ bookings: Booking[] }>('/me/bookings', { headers: authHeaders() }).then((r) => r.bookings);

export const cancelBooking = (bookingId: string) =>
  apiFetch<{ bookingId: string; status: BookingStatus; refundCentavos: number; refundNote: string }>(
    `/bookings/${encodeURIComponent(bookingId)}/cancel`,
    { method: 'POST', headers: authHeaders() },
  );

export const rescheduleBooking = (bookingId: string, startsAt: string) =>
  apiFetch<{ bookingId: string; status: BookingStatus; startsAt: string }>(
    `/bookings/${encodeURIComponent(bookingId)}/reschedule`,
    { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ startsAt }) },
  );

// ---------------------------------------------------------------------------
// Facilitator dashboard
// ---------------------------------------------------------------------------

export interface OwnProfile extends Facilitator {
  email: string;
  legal_name: string | null;
  phone: string | null;
  platform_fee_bps: number;
  vacation_until: string | null;
  payout_details: Record<string, unknown>;
  applied_at: string;
  approved_at: string | null;
}

export interface AvailabilityWindow {
  id?: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface Blackout {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export interface EarningsTotals {
  sessions: number;
  gross: number;
  fees: number;
  net: number;
}

export interface Payout {
  id: string;
  period_start: string;
  period_end: string;
  gross_centavos: number;
  platform_fee_centavos: number;
  processing_fee_centavos: number;
  net_centavos: number;
  status: 'draft' | 'approved' | 'paid' | 'void';
  paid_at: string | null;
  reference: string | null;
}

/**
 * What the application form sends.
 *
 * Typed rather than `Record<string, unknown>` because the field set is now the
 * contract between this form and `validateApplication` on the server, and a
 * renamed field would otherwise fail silently as a missing-required-field 400
 * at submit time rather than at compile time.
 *
 * `email` is absent on purpose: the server takes it from the verified token.
 */
export interface FacilitatorApplication {
  display_name: string;
  bio?: string;
  photo_media_id?: string | null;
  photo_url?: string | null;
  contact_method: ContactMethod;
  phone?: string;
  social_handle?: string;
  website_url?: string;
  years_experience: YearsExperience;
  support_needed: SupportTrack[];
  program_status: ProgramStatus[];
  cert_document_key?: string | null;
  cert_document_name?: string | null;
  referral_source: ReferralSource;
  referral_source_other?: string;
  privacy_accepted: true;
}

export const applyAsFacilitator = (body: FacilitatorApplication) =>
  apiFetch<{ status: string; alreadyApplied?: boolean; reapplied?: boolean }>('/facilitators/apply', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });

/**
 * Uploads one applicant file: presign → PUT straight to S3 → confirm.
 *
 * The bytes never pass through Lambda. That is not only a cost decision — API
 * Gateway caps a request body at 10 MB and base64-encodes binary payloads on
 * the way, so a 8 MB PDF sent through the handler would be rejected as ~11 MB.
 *
 * `kind` decides where the object lands and who can read it back:
 *   'photo'       → the public media bucket, and a media_assets row
 *   'certificate' → a private prefix, readable only through an admin-signed URL
 */
export async function uploadFacilitatorFile(
  kind: 'photo' | 'certificate',
  file: File,
): Promise<{ mediaId: string | null; url: string | null; key: string; filename: string }> {
  const presigned = await apiFetch<{ uploadUrl: string; key: string; publicUrl: string | null }>(
    '/facilitator/upload-url',
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ kind, filename: file.name, contentType: file.type, bytes: file.size }),
    },
  );

  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    // Must match the type bound into the signature, or S3 rejects it.
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!put.ok) throw new Error('That upload did not go through. Please try again.');

  const confirmed = await apiFetch<{ mediaId: string | null; url: string | null }>(
    '/facilitator/upload',
    {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ kind, key: presigned.key, filename: file.name }),
    },
  );

  return {
    mediaId: confirmed.mediaId,
    url: confirmed.url,
    key: presigned.key,
    filename: file.name,
  };
}

export const getMyFacilitatorProfile = () =>
  apiFetch<{ facilitator: OwnProfile }>('/facilitator/me', { headers: authHeaders() }).then(
    (r) => r.facilitator,
  );

export const updateMyFacilitatorProfile = (body: Record<string, unknown>) =>
  apiFetch<{ facilitator: OwnProfile }>('/facilitator/me', {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  }).then((r) => r.facilitator);

export const listMyServices = () =>
  apiFetch<{ services: FacilitatorService[] }>('/facilitator/services', {
    headers: authHeaders(),
  }).then((r) => r.services);

export const createMyService = (body: Record<string, unknown>) =>
  apiFetch<{ service: FacilitatorService }>('/facilitator/services', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  }).then((r) => r.service);

export const updateMyService = (serviceId: string, body: Record<string, unknown>) =>
  apiFetch<{ service: FacilitatorService }>(`/facilitator/services/${encodeURIComponent(serviceId)}`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  }).then((r) => r.service);

export const deactivateMyService = (serviceId: string) =>
  apiFetch<{ deactivated: boolean }>(`/facilitator/services/${encodeURIComponent(serviceId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });

export const getMyAvailability = () =>
  apiFetch<{ windows: AvailabilityWindow[]; timezone: string }>('/facilitator/availability', {
    headers: authHeaders(),
  });

export const saveMyAvailability = (windows: AvailabilityWindow[]) =>
  apiFetch<{ windows: AvailabilityWindow[]; timezone: string }>('/facilitator/availability', {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({
      // Strip ids: the server replaces the grid wholesale rather than diffing.
      windows: windows.map(({ weekday, start_minute, end_minute }) => ({
        weekday,
        start_minute,
        end_minute,
      })),
    }),
  });

export const listMyBlackouts = () =>
  apiFetch<{ blackouts: Blackout[] }>('/facilitator/blackouts', { headers: authHeaders() }).then(
    (r) => r.blackouts,
  );

export const createMyBlackout = (body: { starts_at: string; ends_at: string; reason?: string }) =>
  apiFetch<{ blackout: Blackout }>('/facilitator/blackouts', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  }).then((r) => r.blackout);

export const deleteMyBlackout = (blackoutId: string) =>
  apiFetch<{ deleted: boolean }>(`/facilitator/blackouts/${encodeURIComponent(blackoutId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });

export const listMyFacilitatorBookings = () =>
  apiFetch<{ bookings: Booking[]; timezone: string }>('/facilitator/bookings', {
    headers: authHeaders(),
  });

export const cancelMyFacilitatorBooking = (bookingId: string, reason?: string) =>
  apiFetch<{ bookingId: string; status: BookingStatus; refundCentavos: number }>(
    `/facilitator/bookings/${encodeURIComponent(bookingId)}/cancel`,
    { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ reason }) },
  );

export const markNoShow = (bookingId: string) =>
  apiFetch<{ bookingId: string; status: BookingStatus }>(
    `/facilitator/bookings/${encodeURIComponent(bookingId)}/no-show`,
    { method: 'POST', headers: authHeaders() },
  );

export const getMyEarnings = () =>
  apiFetch<{
    thisMonth: EarningsTotals;
    awaitingPayout: EarningsTotals;
    platformFeeBps: number;
    payouts: Payout[];
  }>('/facilitator/earnings', { headers: authHeaders() });

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminFacilitator extends OwnProfile {
  cognito_sub: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;

  // Intake, from the application form. Every field is nullable or empty for a
  // facilitator an admin entered directly, who never filled one in.
  // `website_url` and `years_experience` are inherited from Facilitator —
  // they are the two intake fields that are also public profile fields.
  contact_method: ContactMethod | null;
  support_needed: SupportTrack[];
  program_status: ProgramStatus[];
  /** Presence means a document exists; the bytes come from a signed URL. */
  cert_document_key: string | null;
  cert_document_name: string | null;
  referral_source: ReferralSource | null;
  referral_source_other: string | null;
  privacy_accepted_at: string | null;
  privacy_policy_version: string | null;
}

export const adminListFacilitators = (
  adminKey: string,
  status?: string,
  support?: string,
) => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (support) params.set('support', support);
  const query = params.toString();
  return apiFetch<{ facilitators: AdminFacilitator[] }>(
    `/admin/facilitators${query ? `?${query}` : ''}`,
    { headers: { 'x-admin-key': adminKey } },
  ).then((r) => r.facilitators);
};

/**
 * A short-lived link to an applicant's credential document.
 *
 * Fetched on click rather than with the rest of the row: the URL expires in
 * five minutes, so one minted when the drawer opened would routinely be dead
 * by the time anyone clicked it.
 */
export const adminGetCertificateUrl = (adminKey: string, facilitatorId: string) =>
  apiFetch<{ url: string; filename: string | null }>(
    `/admin/facilitators/${encodeURIComponent(facilitatorId)}/certificate`,
    { headers: { 'x-admin-key': adminKey } },
  );

/**
 * Enters a facilitator Hilom has already vetted elsewhere — always lands in
 * `applied`, same as a self-submitted application, so it goes through the
 * same Approve / Publish buttons as everyone else.
 */
export const adminCreateFacilitator = (
  adminKey: string,
  body: {
    email: string;
    display_name: string;
    headline?: string;
    credentials?: string[];
    specialties?: string[];
    scope_note?: string;
    admin_notes?: string;
  },
) =>
  apiFetch<{ facilitator: AdminFacilitator }>('/admin/facilitators', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.facilitator);

export const adminGetFacilitator = (adminKey: string, facilitatorId: string) =>
  apiFetch<{ facilitator: AdminFacilitator; services: FacilitatorService[]; bookings: Booking[] }>(
    `/admin/facilitators/${encodeURIComponent(facilitatorId)}`,
    { headers: { 'x-admin-key': adminKey } },
  );

export const adminPatchFacilitator = (
  adminKey: string,
  facilitatorId: string,
  patch: { status?: FacilitatorStatus; platform_fee_bps?: number; admin_notes?: string },
) =>
  apiFetch<{ facilitator: AdminFacilitator }>(
    `/admin/facilitators/${encodeURIComponent(facilitatorId)}`,
    {
      method: 'PATCH',
      headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  ).then((r) => r.facilitator);

/**
 * A booking as the admin sees it — the client's row plus the facilitator it
 * belongs to and the refund ledger, neither of which a client is shown.
 */
export interface AdminBooking extends Booking {
  facilitator_id: string;
  paymongo_payment_id: string | null;
  /** When the promised refund was actually sent. Null while it is owed. */
  refunded_at: string | null;
  refund_reference: string | null;
  facilitators?: {
    slug: string;
    display_name: string;
    email: string;
    photo_url: string | null;
    timezone: string;
  } | null;
}

/** `refund: 'due'` is the work queue — promised refunds nobody has sent yet. */
export const adminListBookings = (
  adminKey: string,
  filter?: { status?: string; refund?: 'due' },
) => {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.refund) params.set('refund', filter.refund);
  const qs = params.toString();
  return apiFetch<{ bookings: AdminBooking[] }>(`/admin/bookings${qs ? `?${qs}` : ''}`, {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.bookings);
};

/** Cancels on Hilom's behalf — always a full refund. */
export const adminCancelBooking = (adminKey: string, bookingId: string, reason?: string) =>
  apiFetch<{ bookingId: string; status: BookingStatus; refundCentavos: number }>(
    `/admin/bookings/${encodeURIComponent(bookingId)}/cancel`,
    {
      method: 'POST',
      headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );

/** Records that a refund has actually been sent. The money moves by hand. */
export const adminMarkRefundSent = (adminKey: string, bookingId: string, reference: string) =>
  apiFetch<{ bookingId: string; refundedAt: string; reference: string }>(
    `/admin/bookings/${encodeURIComponent(bookingId)}/refund`,
    {
      method: 'POST',
      headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    },
  );

export interface AdminPayout extends Payout {
  facilitator_id: string;
  notes: string | null;
  facilitators?: {
    slug: string;
    display_name: string;
    email: string;
    payout_details: Record<string, unknown>;
  } | null;
}

export const adminListPayouts = (adminKey: string) =>
  apiFetch<{ payouts: AdminPayout[] }>('/admin/payouts', {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.payouts);

export const adminBuildPayout = (
  adminKey: string,
  body: {
    facilitator_id: string;
    period_start: string;
    period_end: string;
    processing_fee_centavos?: number;
    notes?: string;
  },
) =>
  apiFetch<{ payout: AdminPayout; sessionCount: number }>('/admin/payouts', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const adminUpdatePayout = (
  adminKey: string,
  payoutId: string,
  patch: { status?: string; reference?: string; notes?: string; processing_fee_centavos?: number },
) =>
  apiFetch<{ payout: AdminPayout }>(`/admin/payouts/${encodeURIComponent(payoutId)}`, {
    method: 'PATCH',
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => r.payout);

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

/**
 * Renders an instant in a named zone, always labelled with that zone.
 *
 * Every time shown anywhere in this feature goes through here or its siblings.
 * A Manila facilitator with an overseas client is the normal case, and an
 * unlabelled "3:00 PM" is how someone misses their session.
 */
export function formatInZone(
  value: string | Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date);
}

/** The viewer's own IANA zone, used to label times shown in local time. */
export function viewerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Manila';
}

/** A short zone label ("GMT+8") for annotating a list of times. */
export function zoneLabel(timezone: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat('en-PH', { timeZone: timezone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timezone;
}

/** "1 hour", "90 minutes" — durations read better than "60 min" in prose. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${minutes} minutes`;
}

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

export const applyAsFacilitator = (body: Record<string, unknown>) =>
  apiFetch<{ status: string; alreadyApplied?: boolean }>('/facilitators/apply', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });

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
}

export const adminListFacilitators = (adminKey: string, status?: string) =>
  apiFetch<{ facilitators: AdminFacilitator[] }>(
    `/admin/facilitators${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    { headers: { 'x-admin-key': adminKey } },
  ).then((r) => r.facilitators);

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

export const adminListBookings = (adminKey: string, status?: string) =>
  apiFetch<{ bookings: Booking[] }>(
    `/admin/bookings${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    { headers: { 'x-admin-key': adminKey } },
  ).then((r) => r.bookings);

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

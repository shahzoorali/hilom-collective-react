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
  /** The facilitator's own notes, shown *beside* the generated policy line. */
  cancellation_policy: string | null;
  /** Notice needed for a full refund, then for half. See `describeRefundPolicy`. */
  refund_full_hours: number;
  refund_half_hours: number;
  /** Pre-session intake questions (0032). Public: a client may read what they are about to be asked. */
  intake_questions: IntakeQuestion[];
  is_active: boolean;
  sort_order: number;
  /**
   * How the meeting link is produced. 'manual' → `meeting_url` is the link.
   * 'google_meet' / 'zoom' → Hilom creates one per booking in the facilitator's
   * connected account, and `meeting_url` is an optional backup.
   */
  meeting_provider: 'manual' | 'google_meet' | 'zoom';
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
  /** The client's zone, captured at booking time. Null on a pre-0028 booking. */
  client_timezone: string | null;
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
  /**
   * A time the facilitator has suggested but the client has not answered
   * (0029). Nothing about the session changes until they accept — see
   * proposeTime in facilitator-portal.ts.
   */
  proposed_starts_at: string | null;
  proposed_at: string | null;
  proposed_note: string | null;
  /** Intake answers, each carrying the question it answered (0032). */
  intake_answers?: IntakeAnswer[];
  intake_completed_at?: string | null;
  /**
   * Who created the row (0031). A 'facilitator' booking was arranged by hand —
   * offline payment, pro bono, a goodwill rebooking — and carries zero in every
   * money column on purpose, because Hilom collected nothing and must not pay
   * out what it does not hold.
   */
  booked_by?: 'client' | 'facilitator';
  /** What the client paid the facilitator directly. A note, never an amount owed. */
  off_platform_centavos?: number | null;
  facilitator_note?: string | null;
  /**
   * The refund ladder snapshotted at booking time (0027). Null on a booking
   * taken before that migration, which is judged by the old fixed 24/12 rule —
   * `bookingRefundPolicy` below resolves both cases.
   */
  refund_full_hours: number | null;
  refund_half_hours: number | null;
  created_at: string;
  facilitators?: { slug: string; display_name: string; photo_url: string | null; timezone: string } | null;
  facilitator_services?: {
    title: string;
    duration_minutes: number;
    /** Present on the client's own list, so a session with no form costs no request. */
    intake_questions?: IntakeQuestion[];
  } | null;
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
  /** Answers to the service's intake form, keyed by question id. */
  intake?: Record<string, string>;
}) =>
  apiFetch<CreateBookingResult>('/bookings', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    // The browser's zone is added here rather than asked for in the form: it
    // is the one thing about the client the platform needs in order to show
    // both parties both times, and nobody should have to type it. The server
    // treats an unrecognised value as absent.
    body: JSON.stringify({ ...input, timezone: viewerTimezone() }),
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

/**
 * A confirmed session that falls inside the facilitator's vacation window.
 *
 * Vacation mode only ever blocked *new* bookings; anything already in the
 * diary stayed put, and nobody told the facilitator. The save returns these so
 * the screen can.
 */
export interface VacationConflict {
  id: string;
  starts_at: string;
  client_name: string | null;
  client_email: string;
  title: string;
}

export const updateMyFacilitatorProfile = (body: Record<string, unknown>) =>
  apiFetch<{ facilitator: OwnProfile; vacationConflicts: VacationConflict[] }>('/facilitator/me', {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Connected meeting accounts
// ---------------------------------------------------------------------------

export type IntegrationProvider = 'google_meet' | 'zoom';

export interface Connection {
  provider: IntegrationProvider;
  label: string;
  connected: boolean;
  /** Which account, so "connected" is not an anonymous green tick. */
  email: string | null;
  scopes: string[];
  connectedAt: string | null;
  /** Revoked or expired upstream — needs reconnecting, not retrying. */
  broken: boolean;
  brokenReason: string | null;
}

export const listMyConnections = () =>
  apiFetch<{ connections: Connection[] }>('/facilitator/integrations', {
    headers: authHeaders(),
  }).then((r) => r.connections);

/**
 * Starts a connect flow.
 *
 * Returns the provider's consent URL rather than following a redirect: the
 * browser has to navigate there itself, because `fetch` following a 302 to
 * accounts.google.com fails CORS before the user ever sees a consent screen.
 */
export const startConnectingProvider = (provider: IntegrationProvider, returnTo?: string) =>
  apiFetch<{ authorizeUrl: string }>(
    `/facilitator/integrations/${encodeURIComponent(provider)}/start`,
    { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ returnTo }) },
  ).then((r) => r.authorizeUrl);

export const disconnectProvider = (provider: IntegrationProvider) =>
  apiFetch<{ disconnected: boolean }>(
    `/facilitator/integrations/${encodeURIComponent(provider)}`,
    { method: 'DELETE', headers: authHeaders() },
  );

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

/**
 * A setting that is, on its own, enough to empty the calendar.
 *
 * Diagnosed server-side by relaxation — see previewAvailability in
 * backend/src/lib/scheduling.ts. `rule` is stable enough to branch on; the
 * message is what to show.
 */
export interface AvailabilityFinding {
  rule:
    | 'no_weekly_hours'
    | 'windows_too_short'
    | 'vacation'
    | 'min_notice'
    | 'max_advance'
    | 'blackouts'
    | 'fully_booked'
    | 'max_per_day';
  message: string;
}

/**
 * What a client would actually be offered for one of my services.
 *
 * Unlike `getAvailability`, this works on an unpublished profile and an
 * inactive service — checking the configuration before going live is the whole
 * point.
 */
export const previewMySlots = (serviceId: string, from: Date, to: Date) =>
  apiFetch<{
    timezone: string;
    durationMinutes: number;
    slots: SlotOption[];
    findings: AvailabilityFinding[];
    isLive: boolean;
  }>(
    `/facilitator/slot-preview?serviceId=${encodeURIComponent(serviceId)}` +
      `&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    { headers: authHeaders() },
  );

/**
 * The facilitator's subscribable calendar URL.
 *
 * `url` is null until they create one — the token is a bearer credential in a
 * string, so it is minted on demand rather than at approval (0030). POST
 * creates *or rotates* it; DELETE revokes it. Rotation is the whole remedy for
 * a link shared by accident.
 */
export const getMyCalendarFeed = () =>
  apiFetch<{ url: string | null }>('/facilitator/calendar-feed', { headers: authHeaders() });

export const createMyCalendarFeed = () =>
  apiFetch<{ url: string | null }>('/facilitator/calendar-feed', {
    method: 'POST',
    headers: authHeaders(),
  });

export const revokeMyCalendarFeed = () =>
  apiFetch<{ url: string | null }>('/facilitator/calendar-feed', {
    method: 'DELETE',
    headers: authHeaders(),
  });

/**
 * Book a client in directly, skipping the public paid flow.
 *
 * `offPlatformPesos` records what they paid the facilitator outside Hilom. It
 * is bookkeeping only — the booking's own money columns are zero, so it never
 * reaches a payout batch. See 0031.
 */
export const createBookingForClient = (input: {
  serviceId: string;
  clientEmail: string;
  clientName?: string;
  startsAt: string;
  offPlatformPesos?: string;
  note?: string;
}) =>
  apiFetch<{ bookingId: string; status: BookingStatus; startsAt: string }>('/facilitator/bookings', {
    method: 'POST',
    headers: jsonAuthHeaders(),
    body: JSON.stringify(input),
  });

export const listMyFacilitatorBookings = () =>
  apiFetch<{ bookings: Booking[]; timezone: string }>('/facilitator/bookings', {
    headers: authHeaders(),
  });

/**
 * Offer the client a different time rather than cancelling on them.
 *
 * An offer, not a move: the session stays where it is until the client accepts.
 */
export const proposeNewTime = (bookingId: string, startsAt: string, note?: string) =>
  apiFetch<{ bookingId: string; proposedStartsAt: string; proposedNote: string | null }>(
    `/facilitator/bookings/${encodeURIComponent(bookingId)}/propose-time`,
    { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ startsAt, note }) },
  );

export const withdrawProposedTime = (bookingId: string) =>
  apiFetch<{ bookingId: string; proposedStartsAt: null }>(
    `/facilitator/bookings/${encodeURIComponent(bookingId)}/withdraw-proposal`,
    { method: 'POST', headers: authHeaders() },
  );

/** The client's answer. Accepting is what actually moves the session. */
export const respondToProposedTime = (bookingId: string, accept: boolean) =>
  apiFetch<{ bookingId: string; accepted: boolean; startsAt: string }>(
    `/bookings/${encodeURIComponent(bookingId)}/${accept ? 'accept-time' : 'decline-time'}`,
    { method: 'POST', headers: authHeaders() },
  );

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
    /**
     * Sessions the facilitator entered themselves this month, and what they
     * reported being paid for them directly. Deliberately outside the totals
     * above: Hilom collected none of it and will pay out none of it (0031).
     */
    offPlatformThisMonth: { sessions: number; centavos: number };
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

/**
 * An instant in the viewer's zone, with the other party's beside it.
 *
 * The dashboards used to render every time in `viewerTimezone()` alone, which
 * is right for the reader and useless for the conversation: a Manila
 * facilitator arranging with a Sydney client needs to see both, every time,
 * or one of them is always converting in their head.
 *
 * Returns a single time whenever the other zone is unknown (a booking taken
 * before it was captured) or resolves to the same wall clock at that instant —
 * "3:00 PM (3:00 PM for them)" is noise that teaches people to skim the line.
 *
 * Mirrors `formatWhenFor` in backend/src/lib/booking-email.ts so a session
 * reads the same in the dashboard as in the email about it.
 */
export function formatDualZone(
  value: string | Date,
  other: { timezone?: string | null; label: string },
  options: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' },
  viewerZone: string = viewerTimezone(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  const mine = `${formatInZone(date, viewerZone, options)} (${zoneLabel(viewerZone, date)})`;

  if (!other.timezone) return mine;
  let theirs: string;
  try {
    theirs = new Intl.DateTimeFormat('en-PH', {
      timeZone: other.timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    // An IANA name this browser does not know. One correct time beats a throw.
    return mine;
  }

  // Same wall clock in both zones — nothing to add.
  if (formatInZone(date, viewerZone, options) === formatInZone(date, other.timezone, options)) {
    return mine;
  }
  return `${mine} · ${theirs} ${other.label}`;
}

/** "1 hour", "90 minutes" — durations read better than "60 min" in prose. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${minutes} minutes`;
}

/** "24 hours" / "1 hour". */
function hoursPhrase(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The cancellation policy as a sentence, from the numbers the backend will
 * actually apply.
 *
 * A deliberate second copy of `describeRefundPolicy` in
 * `backend/src/lib/booking-domain.ts`. The two must say the same thing, and the
 * duplication is the price of the frontend not importing across the workspace
 * boundary — but only the *wording* is duplicated. The thresholds themselves
 * come from the service row, so the number a client reads is always the number
 * the refund is computed from, which is the whole point of the change.
 */
/**
 * The ladder a *booking* is judged by, snapshot or pre-0027 default.
 *
 * The frontend needs this to tell someone what cancelling will cost them
 * before they confirm it. The backend recomputes the same thing from the same
 * columns when the cancellation actually lands, so this is a preview, never
 * the decision.
 */
export function bookingRefundPolicy(booking: {
  refund_full_hours: number | null;
  refund_half_hours: number | null;
}): { refund_full_hours: number; refund_half_hours: number } {
  const full = booking.refund_full_hours ?? 24;
  return {
    refund_full_hours: full,
    refund_half_hours: Math.min(full, booking.refund_half_hours ?? 12),
  };
}

export function describeRefundPolicy(service: {
  refund_full_hours: number;
  refund_half_hours: number;
}): string {
  const full = service.refund_full_hours ?? 24;
  const half = Math.min(full, service.refund_half_hours ?? 12);

  if (full === 0) return 'Cancel at any time before the session for a full refund.';
  if (half === full) {
    return (
      `Cancel at least ${hoursPhrase(full)} before the session for a full refund. ` +
      'Closer than that, the session is not refundable.'
    );
  }
  if (half === 0) {
    return `Cancel at least ${hoursPhrase(full)} before the session for a full refund, or later for a half refund.`;
  }
  return (
    `Cancel at least ${hoursPhrase(full)} before the session for a full refund, ` +
    `or at least ${hoursPhrase(half)} before for a half refund. ` +
    `Under ${hoursPhrase(half)}, the session is not refundable.`
  );
}

// ---------------------------------------------------------------------------
// Pre-session intake (0032)
// ---------------------------------------------------------------------------

export const INTAKE_QUESTION_TYPES = ['text', 'longtext', 'choice', 'checkbox'] as const;
export type IntakeQuestionType = (typeof INTAKE_QUESTION_TYPES)[number];

export interface IntakeQuestion {
  id: string;
  label: string;
  help: string | null;
  type: IntakeQuestionType;
  required: boolean;
  options: string[];
}

/**
 * An answer, with a copy of the question it answered.
 *
 * The label is snapshotted server-side so a facilitator rewriting their form
 * cannot change what a client was asked — which means the facilitator's view
 * renders `label` from the answer, never by looking the question up again.
 */
export interface IntakeAnswer {
  id: string;
  label: string;
  value: string;
}

export const getMyBookingIntake = (bookingId: string) =>
  apiFetch<{
    questions: IntakeQuestion[];
    answers: IntakeAnswer[];
    completedAt: string | null;
    editable: boolean;
  }>(`/bookings/${encodeURIComponent(bookingId)}/intake`, { headers: authHeaders() });

export const saveMyBookingIntake = (bookingId: string, intake: Record<string, string>) =>
  apiFetch<{ answers: IntakeAnswer[]; completedAt: string }>(
    `/bookings/${encodeURIComponent(bookingId)}/intake`,
    { method: 'PUT', headers: jsonAuthHeaders(), body: JSON.stringify({ intake }) },
  );

/**
 * A stable id for a new question, derived from its label.
 *
 * Derived rather than positional because an answer joins on it: inserting a
 * question above another must not silently re-point every answer already
 * given. Collisions are separated server-side, so a near-duplicate here is
 * safe.
 */
export function intakeQuestionId(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || `q${index + 1}`;
}

// ---------------------------------------------------------------------------
// Clients (0033)
// ---------------------------------------------------------------------------

export interface ClientSummary {
  email: string;
  name: string | null;
  sessions: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  nextSessionAt: string | null;
  netCentavos: number;
  hasAbout: boolean;
}

/** One session in a client's timeline, with both kinds of note attached. */
export interface ClientBooking {
  id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  price_centavos: number;
  facilitator_net_centavos: number;
  off_platform_centavos: number | null;
  booked_by: 'client' | 'facilitator';
  client_name: string | null;
  /** What the client wrote at booking time. */
  client_notes: string | null;
  /** What the facilitator wrote about the session. Never shown to the client. */
  session_notes: string | null;
  intake_answers: IntakeAnswer[];
  intake_completed_at: string | null;
  facilitator_services: { title: string; duration_minutes: number } | null;
}

export const listMyClients = () =>
  apiFetch<{ clients: ClientSummary[] }>('/facilitator/clients', { headers: authHeaders() }).then(
    (r) => r.clients,
  );

/**
 * One client's history with this facilitator.
 *
 * The address goes in the path rather than a query string — that is the one
 * place URLs reliably end up in logs and referrers, and this one identifies a
 * person.
 */
export const getMyClient = (email: string) =>
  apiFetch<{
    email: string;
    name: string | null;
    about: string | null;
    aboutUpdatedAt: string | null;
    bookings: ClientBooking[];
  }>(`/facilitator/clients/${encodeURIComponent(email)}`, { headers: authHeaders() });

export const saveMyClientAbout = (email: string, about: string) =>
  apiFetch<{ about: string | null }>(`/facilitator/clients/${encodeURIComponent(email)}`, {
    method: 'PUT',
    headers: jsonAuthHeaders(),
    body: JSON.stringify({ about }),
  });

export const saveMySessionNotes = (bookingId: string, notes: string) =>
  apiFetch<{ bookingId: string; sessionNotes: string | null }>(
    `/facilitator/bookings/${encodeURIComponent(bookingId)}/notes`,
    { method: 'PUT', headers: jsonAuthHeaders(), body: JSON.stringify({ notes }) },
  );

// ---------------------------------------------------------------------------
// Messages (0034)
// ---------------------------------------------------------------------------

export interface BookingMessage {
  id: string;
  sender: 'client' | 'facilitator';
  body: string;
  created_at: string;
  /** Null while the other party has not opened the thread. */
  read_at: string | null;
}

/**
 * One thread in the facilitator's inbox.
 *
 * A facilitator's unit of attention is not the booking — someone with a full
 * week does not open twelve sessions to find out whether anyone asked them
 * anything.
 */
export interface MessageThread {
  bookingId: string;
  lastMessage: string;
  lastSender: 'client' | 'facilitator';
  lastAt: string;
  unread: number;
  startsAt: string | null;
  status: BookingStatus | null;
  clientName: string | null;
  clientEmail: string | null;
  serviceTitle: string;
}

/** Reading the thread marks the other side's messages read. */
export const listBookingMessages = (bookingId: string, asFacilitator = false) =>
  apiFetch<{ messages: BookingMessage[] }>(
    asFacilitator
      ? `/facilitator/bookings/${encodeURIComponent(bookingId)}/messages`
      : `/bookings/${encodeURIComponent(bookingId)}/messages`,
    { headers: authHeaders() },
  ).then((r) => r.messages);

export const sendBookingMessage = (bookingId: string, body: string, asFacilitator = false) =>
  apiFetch<{ message: BookingMessage }>(
    asFacilitator
      ? `/facilitator/bookings/${encodeURIComponent(bookingId)}/messages`
      : `/bookings/${encodeURIComponent(bookingId)}/messages`,
    { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ body }) },
  ).then((r) => r.message);

export const listMyMessageThreads = () =>
  apiFetch<{ threads: MessageThread[] }>('/facilitator/messages', { headers: authHeaders() }).then(
    (r) => r.threads,
  );

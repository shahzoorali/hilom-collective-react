/**
 * Event registration API client.
 *
 * Same conventions as booking.ts: `apiFetch` for transport, the Cognito id
 * token attached per call by hand (there is no interceptor and no auth
 * context), and a thrown Error whose message is the backend's own wording —
 * which the pages render directly, because the backend writes those messages
 * for the person reading them.
 */
import { apiFetch } from './api';
import { idToken } from './auth';

const authHeaders = (): Record<string, string> => {
  const token = idToken();
  if (!token) throw new Error('Sign in to continue');
  return { Authorization: `Bearer ${token}` };
};

const jsonAuthHeaders = (): Record<string, string> => ({
  ...authHeaders(),
  'Content-Type': 'application/json',
});

/**
 * Runs a call that builds auth headers, turning a missing token into a
 * *rejected promise* rather than a synchronous throw.
 *
 * Without this, `authHeaders()` throws while the call expression is still
 * being evaluated — before `apiFetch` returns anything — so the `.catch()` a
 * caller attached never gets the chance to attach at all. In a `useEffect`
 * that escapes as an uncaught error and React unmounts the tree: a signed-out
 * visitor following a link from a confirmation email got a blank white page
 * instead of a sign-in prompt. Every authenticated call below goes through
 * here so that failure mode cannot come back.
 */
async function withAuth<T>(call: () => Promise<T>): Promise<T> {
  return await call();
}

export type PaymentPlanKind = 'full' | 'installment';

export interface PlanInstallment {
  seq: number;
  label: string;
  amount_centavos: number;
  /** Null for the deposit, which falls due at registration. */
  due_at: string | null;
  due_offset_days: number | null;
  is_deposit: boolean;
}

export interface EventPlan {
  id: string;
  name: string;
  description: string | null;
  kind: PaymentPlanKind;
  total_centavos: number;
  currency: string;
  available_from: string | null;
  available_until: string | null;
  sort_order: number;
  installments: PlanInstallment[];
}

export interface EventFacilitator {
  name: string;
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  photo_alt: string | null;
}

export interface EventGalleryImage {
  url: string;
  alt: string;
}

export interface TicketedEvent {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  image_url: string | null;
  image_alt: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  currency: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  venue_details: string | null;
  terms_html: string | null;
  registrant_fields: string[];
  facilitators: EventFacilitator[];
  gallery: EventGalleryImage[];
}

export interface TicketingResponse {
  event: TicketedEvent;
  open: boolean;
  /**
   * Advisory only. Counted outside the row lock that actually allocates a
   * place, so a registration can still come back sold out after this said
   * there was room — see the note on the endpoint.
   */
  placesRemaining: number;
  plans: EventPlan[];
}

export const getEventTicketing = (eventId: string) =>
  apiFetch<TicketingResponse>(`/events/${eventId}/ticketing`);

export interface RegisterInput {
  planId: string;
  registrant: {
    name: string;
    email: string;
    phone?: string;
    details: Record<string, string>;
  };
}

export interface RegisterResult {
  registrationId: string;
  chargeId: string;
  checkoutUrl: string;
  amountCentavos: number;
  currency: string;
  holdExpiresAt: string;
  planName: string;
  totalCentavos: number;
}

export const registerForEvent = (eventId: string, input: RegisterInput) =>
  withAuth(() =>
    apiFetch<RegisterResult>(`/events/${eventId}/register`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(input),
    }),
  );

export interface RegistrationStatus {
  registrationId: string;
  status: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled' | 'completed';
  planName: string;
  totalCentavos: number;
  currency: string;
  eventTitle: string | null;
  startsAt: string | null;
  location: string | null;
}

export const getRegistrationStatus = (registrationId: string) =>
  withAuth(() =>
    apiFetch<RegistrationStatus>(`/registrations/${registrationId}/status`, {
      headers: authHeaders(),
    }),
  );

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A due date as the Manila calendar day it means.
 *
 * Due dates are stored as the last second of a Manila day. Rendered in the
 * viewer's own zone, a payment due "31 October" shows as 1 November to anyone
 * east of the Philippines — so this pins the zone rather than trusting the
 * browser, and shows no time, because "11:59 PM" reads as a deadline in
 * minutes rather than a day someone has.
 */
export const formatDueDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));

/** The event's dates, collapsed to a range when it spans more than one day. */
export function formatEventDates(startsAt: string, endsAt: string | null): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(iso));

  if (!endsAt) return fmt(startsAt);
  const start = fmt(startsAt);
  const end = fmt(endsAt);
  return start === end ? start : `${start} — ${end}`;
}

/** What a plan asks for up front — the deposit, or the whole amount. */
export const dueNow = (plan: EventPlan): number =>
  plan.installments.find((i) => i.is_deposit)?.amount_centavos ?? plan.total_centavos;

// ---------------------------------------------------------------------------
// Your own registrations
// ---------------------------------------------------------------------------

export type ChargeStatus =
  | 'scheduled'
  | 'awaiting_payment'
  | 'paid'
  | 'waived'
  | 'void'
  | 'refunded';

export interface RegistrationCharge {
  id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: ChargeStatus;
  paid_at: string | null;
  receipt_no: string | null;
}

export interface MyRegistration {
  id: string;
  event_id: string;
  status: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled' | 'completed';
  registrant_name: string;
  registrant_email: string;
  registrant_phone: string | null;
  registrant_details: Record<string, string>;
  plan_name: string;
  plan_kind: PaymentPlanKind;
  total_centavos: number;
  currency: string;
  hold_expires_at: string | null;
  confirmed_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_decided_at: string | null;
  cancellation_decision: 'approved' | 'declined' | null;
  created_at: string;
  charges: RegistrationCharge[];
  paidCentavos: number;
  outstandingCentavos: number;
  fullySettled: boolean;
  /** The only charge the server will accept payment for right now. */
  nextChargeId: string | null;
  events: {
    title: string;
    starts_at: string;
    ends_at: string | null;
    location: string | null;
    image_url: string | null;
    venue_details?: string | null;
  } | null;
}

export const listMyRegistrations = () =>
  withAuth(() =>
    apiFetch<{ registrations: MyRegistration[] }>('/me/registrations', {
      headers: authHeaders(),
    }).then((r) => r.registrations),
  );

export const getMyRegistration = (registrationId: string) =>
  withAuth(() =>
    apiFetch<{ registration: MyRegistration }>(`/registrations/${registrationId}`, {
      headers: authHeaders(),
    }).then((r) => r.registration),
  );

export interface PayResult {
  chargeId: string;
  checkoutUrl: string;
  amountCentavos: number;
  currency: string;
  /** True when an already-open session was handed back instead of a new one. */
  reused: boolean;
}

export const payCharge = (registrationId: string, chargeId: string) =>
  withAuth(() =>
    apiFetch<PayResult>(`/registrations/${registrationId}/charges/${chargeId}/pay`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
    }),
  );

export const payBalance = (registrationId: string) =>
  withAuth(() =>
    apiFetch<PayResult>(`/registrations/${registrationId}/pay-balance`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
    }),
  );

/** Whether a charge still represents money owed. */
export const isOutstanding = (status: ChargeStatus): boolean =>
  status === 'scheduled' || status === 'awaiting_payment';

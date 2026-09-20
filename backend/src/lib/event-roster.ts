/**
 * One event's roster, and the money over it.
 *
 * Extracted from handlers/admin-registrations.ts, unchanged, because a second
 * audience now needs the identical answer: the facilitator hosting the event
 * reads the same roster from their own dashboard. Two copies of "what is this
 * registration's outstanding balance" would eventually disagree, and the one
 * that disagrees is always the one somebody reads before emailing an attendee.
 *
 * Nothing here checks authorization. Both callers do that first — the admin
 * handler with the shared admin key, the portal by matching
 * events.facilitator_id against the caller's own facilitator row — and this
 * module assumes the question has already been answered.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isOutstanding,
  outstandingCentavos,
  paidCentavos,
  nextDueCharge,
  type ChargeStatus,
} from './event-ticketing.js';

export const REGISTRATION_COLUMNS =
  'id, event_id, plan_id, status, seat_no, buyer_email, buyer_cognito_sub, registrant_name, ' +
  'registrant_email, registrant_phone, registrant_details, transferred_at, plan_name, plan_kind, ' +
  'total_centavos, currency, price_override_centavos, price_override_reason, hold_expires_at, ' +
  'confirmed_at, flagged_at, flag_reason, cancellation_requested_at, cancellation_reason, ' +
  'cancellation_decided_at, cancellation_decision, cancelled_at, cancelled_by, refund_centavos, ' +
  'refunded_at, refund_reference, admin_notes, created_at, updated_at';

export const CHARGE_COLUMNS =
  'id, registration_id, seq, label, is_deposit, amount_centavos, currency, due_at, status, paid_at, ' +
  'paid_method, paid_reference, receipt_no, flagged_at, voided_at, void_reason, paymongo_payment_id';

/** Statuses that hold, or have held, a place. */
export const LIVE = ['pending_payment', 'confirmed'];

export interface RegistrationRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  status: string;
  seat_no: number;
  buyer_email: string;
  registrant_name: string;
  plan_kind: 'full' | 'installment';
  total_centavos: number;
  currency: string;
  // Declared rather than left to the index signature: the cancellation
  // lifecycle does arithmetic and null checks on these, and `unknown` from
  // Record<string, unknown> makes both an error.
  refund_centavos: number | null;
  refunded_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_decided_at: string | null;
}

export interface ChargeRow extends Record<string, unknown> {
  id: string;
  registration_id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: ChargeStatus;
}

export interface EventRow extends Record<string, unknown> {
  id: string;
  title: string;
  capacity: number | null;
  currency: string;
  starts_at: string;
}

/** Charges keyed by registration, for a set of registrations. */
export async function chargesFor(
  supabase: SupabaseClient,
  registrationIds: string[],
): Promise<Map<string, ChargeRow[]>> {
  const byRegistration = new Map<string, ChargeRow[]>();
  if (registrationIds.length === 0) return byRegistration;

  const { data, error } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    .in('registration_id', registrationIds)
    .order('seq', { ascending: true })
    .returns<ChargeRow[]>();
  if (error) throw error;

  for (const charge of data ?? []) {
    byRegistration.set(charge.registration_id, [...(byRegistration.get(charge.registration_id) ?? []), charge]);
  }
  return byRegistration;
}

/** The derived figures every roster view shows, computed from the ledger. */
export function decorate(
  registration: RegistrationRow,
  charges: ChargeRow[],
  now: Date,
): Record<string, unknown> {
  const overdue = charges.filter((c) => isOutstanding(c.status) && Date.parse(c.due_at) < now.getTime());
  return {
    ...registration,
    charges,
    paidCentavos: paidCentavos(charges),
    outstandingCentavos: outstandingCentavos(charges),
    overdueCentavos: overdue.reduce((acc, c) => acc + c.amount_centavos, 0),
    overdueCount: overdue.length,
    nextDue: nextDueCharge(charges),
  };
}

/**
 * One event's roster and its money, in a single read.
 *
 * Deliberately one call rather than a roster query plus a totals query: the
 * totals are a sum over exactly the rows already being returned, and two
 * queries would mean two round trips that can disagree with each other by a
 * payment that landed in between.
 *
 * Returns null when no such event exists, so the caller decides the wording of
 * the 404 — the admin and the facilitator are answering different questions
 * ("no such event" vs "not an event of yours") and must not be told apart.
 */
export async function buildRoster(
  supabase: SupabaseClient,
  eventId: string,
  now = new Date(),
): Promise<{
  event: EventRow;
  registrations: Record<string, unknown>[];
  money: Record<string, number | string>;
} | null> {
  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title, capacity, currency, starts_at')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (eventError) throw eventError;
  if (!eventRow) return null;

  const { data: registrations, error } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('event_id', eventId)
    .order('seat_no', { ascending: true })
    .returns<RegistrationRow[]>();
  if (error) throw error;

  const rows = registrations ?? [];
  const byRegistration = await chargesFor(supabase, rows.map((r) => r.id));
  const decorated = rows.map((r) => decorate(r, byRegistration.get(r.id) ?? [], now));

  // Money is counted over live registrations only. A cancelled place's paid
  // charges are real money that was received, but counting them in "collected"
  // for an event would overstate what the event actually earned — they belong
  // to the refund conversation, which is why they surface separately.
  const live = decorated.filter((r) => LIVE.includes(String(r.status)));
  const cancelled = decorated.filter((r) => r.status === 'cancelled');

  const sum = (list: Record<string, unknown>[], key: string) =>
    list.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);

  const taken = live.length;
  const capacity = eventRow.capacity ?? 0;

  return {
    event: eventRow,
    registrations: decorated,
    money: {
      currency: eventRow.currency,
      capacity,
      placesTaken: taken,
      placesFree: Math.max(0, capacity - taken),
      collectedCentavos: sum(live, 'paidCentavos'),
      outstandingCentavos: sum(live, 'outstandingCentavos'),
      overdueCentavos: sum(live, 'overdueCentavos'),
      // Expected total if every live registration pays in full.
      expectedCentavos: sum(live, 'paidCentavos') + sum(live, 'outstandingCentavos'),
      cancelledPaidCentavos: sum(cancelled, 'paidCentavos'),
      refundsOwedCentavos: decorated
        .filter((r) => Number(r.refund_centavos ?? 0) > 0 && !r.refunded_at)
        .reduce((acc, r) => acc + Number(r.refund_centavos ?? 0), 0),
    },
  };
}

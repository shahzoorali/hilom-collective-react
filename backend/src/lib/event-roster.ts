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
import { sendJoinDetails } from './registration-email.js';
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

/**
 * Statuses that hold, or have held, a place -- as opposed to cancelled or
 * expired, which never took it or gave it back.
 *
 * `completed` belongs here and its absence was a real bug: registration-sweep.ts
 * moves a `confirmed` registration to `completed` once the event's date has
 * passed, which is correct and is what marks a session as delivered. But every
 * money total on the roster screen, and the CSV export, are built by filtering
 * on this list -- so the moment an event finished, its attendees dropped out of
 * "live" and the roster read Places 0 of 20, Collected P0.00, on an event eight
 * people had actually paid for and attended. sendJoinDetails, lower in this
 * same file, already treats 'confirmed' and 'completed' as the same live
 * status for the purpose of emailing attendees; this list just never matched.
 */
export const LIVE = ['pending_payment', 'confirmed', 'completed'];

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
  /** Still waiting for a seat (0060) — `notified` counts too, since they have not converted yet. */
  waitlistCount: number;
} | null> {
  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title, capacity, currency, starts_at')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (eventError) throw eventError;
  if (!eventRow) return null;

  const { count: waitlistCount, error: waitlistError } = await supabase
    .from('event_waitlist')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', ['waiting', 'notified']);
  if (waitlistError) throw waitlistError;

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
    waitlistCount: waitlistCount ?? 0,
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

// ---------------------------------------------------------------------------
// Joining details
// ---------------------------------------------------------------------------

/** The event fields a joining-details send needs. */
export interface JoinDetailsEvent extends Record<string, unknown> {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location?: string | null;
  venue_details?: string | null;
  format?: string | null;
  join_url: string | null;
  join_instructions: string | null;
}

export interface JoinDetailsResult {
  sent: number;
  /** Told for the first time — they get "Here is how to join X". */
  firstTime: number;
  /** Told before — they get "the link has changed, ignore the earlier one". */
  resent: number;
}

/**
 * Emails the joining details to everyone holding a confirmed place.
 *
 * Shared by the facilitator's own dashboard and by admin, because "who gets
 * told, and which wording do they get" is one rule and two copies of it would
 * drift. Authorization is the caller's job and has already happened by here:
 * the portal matches events.facilitator_id against the caller's own row, admin
 * holds the shared key.
 *
 * **Confirmed only.** A `pending_payment` row is an unfinished checkout whose
 * seat is about to lapse, and the registrant's own page withholds the link for
 * the same reason.
 *
 * **Addressed to the registrant, not the buyer.** A parent who paid for their
 * daughter's place is not the one who needs to join. Where the two are the same
 * address, which is the common case, this is the same person anyway.
 *
 * **The wording is decided per person**, from `join_details_sent_at` (0046):
 * someone who has never been told gets "here is how to join", someone who has
 * gets "the link has changed". One answer for the whole roster is wrong as soon
 * as a roster contains both kinds of person, which it does the moment anyone
 * registers between two sends.
 */
export async function sendJoinDetailsToRegistrants(
  supabase: SupabaseClient,
  event: JoinDetailsEvent,
): Promise<JoinDetailsResult> {
  if (!event.join_url) return { sent: 0, firstTime: 0, resent: 0 };

  const { data, error } = await supabase
    .from('event_registrations')
    .select('id, registrant_name, registrant_email, buyer_email, join_details_sent_at')
    .eq('event_id', event.id)
    .in('status', ['confirmed', 'completed'])
    .returns<
      {
        id: string;
        registrant_name: string;
        registrant_email: string | null;
        buyer_email: string;
        join_details_sent_at: string | null;
      }[]
    >();
  if (error) throw error;

  const recipients = data ?? [];
  const emailEvent = {
    title: event.title,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    location: event.location ?? null,
    venue_details: event.venue_details ?? null,
    format: event.format ?? null,
    join_url: event.join_url,
    join_instructions: event.join_instructions,
  };

  let firstTime = 0;
  let resent = 0;
  const stamped: string[] = [];

  // Sequential, not Promise.all: this is a handful of SES calls against a
  // shared send rate, and a burst of forty is the one that gets throttled.
  // sendJoinDetails swallows its own failures, so one bad address cannot stop
  // the rest.
  for (const r of recipients) {
    const previouslyTold = r.join_details_sent_at !== null;
    await sendJoinDetails({
      to: r.registrant_email || r.buyer_email,
      registrantName: r.registrant_name,
      registrationId: r.id,
      event: emailEvent,
      updated: previouslyTold,
    });
    if (previouslyTold) resent += 1;
    else firstTime += 1;
    stamped.push(r.id);
  }

  if (stamped.length > 0) {
    // Stamped after the fact, in one write. sendJoinDetails does not report
    // failure — it logs and swallows, so that a bad address cannot break a
    // payment flow — so this cannot distinguish sent from attempted. Recording
    // the attempt is the safer of the two errors: the cost of over-recording is
    // that someone who never got the first email is told a link "changed", and
    // the cost of under-recording is telling someone who did get it that this
    // is their first. Both are mild; only one of them is silent.
    const { error: stampError } = await supabase
      .from('event_registrations')
      .update({ join_details_sent_at: new Date().toISOString() })
      .in('id', stamped);
    if (stampError) throw stampError;
  }

  return { sent: recipients.length, firstTime, resent };
}

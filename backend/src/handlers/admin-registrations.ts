/**
 * Admin operations on event registrations.
 *
 *   GET  /admin/events/{eventId}/roster
 *   GET  /admin/events/{eventId}/roster.csv
 *   GET  /admin/registrations                     ?flagged=1 ?eventId= ?status=
 *   GET  /admin/registrations/{registrationId}
 *   POST /admin/registrations/{registrationId}/cancel
 *   POST /admin/registrations/{registrationId}/cancellation-decision
 *   POST /admin/registrations/{registrationId}/refund-sent
 *   POST /admin/registrations/{registrationId}/price-override
 *   POST /admin/registrations/{registrationId}/nudge
 *   POST /admin/registrations/{registrationId}/charges/{chargeId}/mark-paid
 *   POST /admin/registrations/{registrationId}/charges/{chargeId}/waive
 *   POST /admin/registrations/{registrationId}/charges/{chargeId}/void
 *   GET  /admin/audit-log
 *
 * Authorized with the shared admin key (`isAuthorizedAdmin`), matching every
 * other admin surface here. Consequence worth stating: the key identifies an
 * office, not a person, so the audit trail records an *attestation* — see
 * lib/audit.ts.
 *
 * **Marking a payment received offline goes through applyChargePayment**, the
 * same function the webhook calls, rather than writing `status: 'paid'` here.
 * That is what makes a bank transfer produce the same seat confirmation, the
 * same receipt number and the same emails as a QR Ph payment. Two paths to
 * "this is paid" would eventually disagree about one of the three.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAuthorizedAdmin } from '../lib/http.js';
import { actorFromEvent, recordAudit, type AuditActor } from '../lib/audit.js';
import { csvResponse, csvSlug } from '../lib/csv.js';
import { applyChargePayment } from '../lib/registration-fulfillment.js';
import {
  sendRegistrationCancelled,
  sendPaymentNudge,
  sendCancellationDeclined,
} from '../lib/registration-email.js';
import {
  isOutstanding,
  outstandingCentavos,
  paidCentavos,
  nextDueCharge,
  assessRefund,
  type ChargeStatus,
  type RefundAssessment,
} from '../lib/event-ticketing.js';

const conflict = (message: string) => json(409, { error: message });

const REGISTRATION_COLUMNS =
  'id, event_id, plan_id, status, seat_no, buyer_email, buyer_cognito_sub, registrant_name, ' +
  'registrant_email, registrant_phone, registrant_details, transferred_at, plan_name, plan_kind, ' +
  'total_centavos, currency, price_override_centavos, price_override_reason, hold_expires_at, ' +
  'confirmed_at, flagged_at, flag_reason, cancellation_requested_at, cancellation_reason, ' +
  'cancellation_decided_at, cancellation_decision, cancelled_at, cancelled_by, refund_centavos, ' +
  'refunded_at, refund_reference, admin_notes, created_at, updated_at';

const CHARGE_COLUMNS =
  'id, registration_id, seq, label, is_deposit, amount_centavos, currency, due_at, status, paid_at, ' +
  'paid_method, paid_reference, receipt_no, flagged_at, voided_at, void_reason, paymongo_payment_id';

/** Statuses that hold, or have held, a place. */
const LIVE = ['pending_payment', 'confirmed'];

interface RegistrationRow extends Record<string, unknown> {
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

interface ChargeRow extends Record<string, unknown> {
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

interface EventRow extends Record<string, unknown> {
  id: string;
  title: string;
  capacity: number | null;
  currency: string;
  starts_at: string;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const actor = actorFromEvent(event);

  const eventId = event.pathParameters?.eventId;
  const registrationId = event.pathParameters?.registrationId;
  const chargeId = event.pathParameters?.chargeId;

  try {
    // Every branch awaited, never bare-returned: a returned pending promise
    // escapes this try before rejecting and becomes an uncaught Lambda
    // rejection instead of a 400.
    if (eventId && method === 'GET' && path.endsWith('/roster.csv')) {
      return await rosterCsv(eventId, actor);
    }
    if (eventId && method === 'GET' && path.endsWith('/roster')) {
      return await roster(eventId);
    }
    if (method === 'GET' && path.endsWith('/admin/audit-log')) {
      return await auditLog(event.queryStringParameters ?? {});
    }

    if (registrationId && chargeId && method === 'POST') {
      const body = parseBody(event);
      if (path.endsWith('/mark-paid')) return await markPaid(registrationId, chargeId, body, actor);
      if (path.endsWith('/waive')) return await settleWithout(registrationId, chargeId, body, actor, 'waived');
      if (path.endsWith('/void')) return await settleWithout(registrationId, chargeId, body, actor, 'void');
      return badRequest(`Unsupported action ${path}`);
    }

    if (registrationId && method === 'POST') {
      const body = parseBody(event);
      // Literal suffixes checked before '/cancel', which would otherwise also
      // match '/cancellation-decision' under endsWith.
      if (path.endsWith('/cancellation-decision')) {
        return await cancellationDecision(registrationId, body, actor);
      }
      if (path.endsWith('/refund-sent')) return await refundSent(registrationId, body, actor);
      if (path.endsWith('/price-override')) return await priceOverride(registrationId, body, actor);
      if (path.endsWith('/cancel')) return await cancel(registrationId, body, actor);
      if (path.endsWith('/nudge')) return await nudge(registrationId, body, actor);
      return badRequest(`Unsupported action ${path}`);
    }

    if (registrationId && method === 'GET' && path.endsWith('/refund-assessment')) {
      return await refundAssessment(registrationId, event.queryStringParameters ?? {});
    }
    if (registrationId && method === 'GET') {
      return await registrationDetail(registrationId);
    }
    if (method === 'GET' && path.endsWith('/admin/registrations')) {
      return await queue(event.queryStringParameters ?? {});
    }

    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    return serverError('adminRegistrations', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Charges keyed by registration, for a set of registrations. */
async function chargesFor(
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

/** The derived figures every admin view shows, computed from the ledger. */
function decorate(registration: RegistrationRow, charges: ChargeRow[], now: Date): Record<string, unknown> {
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
 * One event's roster and its money, in a single response.
 *
 * Deliberately one call rather than a roster endpoint plus a totals endpoint:
 * the totals are a sum over exactly the rows already being returned, and two
 * endpoints would mean two round trips that can disagree with each other by a
 * payment that landed in between.
 */
async function roster(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const now = new Date();

  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title, capacity, currency, starts_at')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (eventError) throw eventError;
  if (!eventRow) return notFound('Event not found');

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

  return ok({
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
  });
}

/**
 * The cross-event attention queue.
 *
 * Defaults to everything needing a human: a flagged registration, an overdue
 * payment, or a cancellation someone asked for and nobody has answered. That
 * default is the whole point of the screen — a list of every registration ever
 * is a report, not a queue.
 */
async function queue(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const now = new Date();

  let builder = supabase.from('event_registrations').select(REGISTRATION_COLUMNS);

  if (query.eventId) builder = builder.eq('event_id', query.eventId);
  if (query.status) builder = builder.eq('status', query.status);

  const { data, error } = await builder
    .order('created_at', { ascending: false })
    .limit(500)
    .returns<RegistrationRow[]>();
  if (error) throw error;

  const rows = data ?? [];
  const byRegistration = await chargesFor(supabase, rows.map((r) => r.id));
  let decorated = rows.map((r) => decorate(r, byRegistration.get(r.id) ?? [], now));

  // Unanswered cancellation requests only — a narrower queue than `flagged`,
  // for working through decisions rather than everything needing attention.
  if (query.cancelRequests === '1') {
    decorated = decorated.filter(
      (r) => r.cancellation_requested_at !== null && r.cancellation_decided_at === null,
    );
  } else if (query.flagged === '1') {
    decorated = decorated.filter(
      (r) =>
        r.flagged_at !== null ||
        Number(r.overdueCount ?? 0) > 0 ||
        (r.cancellation_requested_at !== null && r.cancellation_decided_at === null),
    );
  }

  return ok({ registrations: decorated });
}

async function registrationDetail(registrationId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const now = new Date();

  const { data, error } = await supabase
    .from('event_registrations')
    .select(`${REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location)`)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow>();
  if (error) throw error;
  if (!data) return notFound('Registration not found');

  const byRegistration = await chargesFor(supabase, [registrationId]);

  // The trail for this registration, so a money question is answerable without
  // leaving the row it is about.
  const { data: audit } = await supabase
    .from('admin_audit_log')
    .select('id, actor_source, actor_label, source_ip, action, amount_centavos, currency, note, before, after, created_at')
    .eq('target_id', registrationId)
    .order('created_at', { ascending: false })
    .limit(50);

  return ok({
    registration: decorate(data, byRegistration.get(registrationId) ?? [], now),
    audit: audit ?? [],
  });
}

/**
 * The roster as CSV, for the venue.
 *
 * Builds its own response object because `json()` in http.ts hard-codes
 * `Content-Type: application/json` — do not "tidy" this back into ok().
 *
 * The export is audited: this file carries dietary requirements, medical notes
 * and emergency contacts, and a record that it left the system is the only
 * trace that a PII export happened at all.
 */
async function rosterCsv(eventId: string, actor: AuditActor): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const now = new Date();

  const { data: eventRow } = await supabase
    .from('events')
    .select('id, title, capacity, currency, starts_at')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (!eventRow) return notFound('Event not found');

  const { data: registrations, error } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('event_id', eventId)
    .in('status', LIVE)
    .order('seat_no', { ascending: true })
    .returns<RegistrationRow[]>();
  if (error) throw error;

  const rows = registrations ?? [];
  const byRegistration = await chargesFor(supabase, rows.map((r) => r.id));

  const detailKeys = [
    ...new Set(rows.flatMap((r) => Object.keys((r.registrant_details ?? {}) as Record<string, string>))),
  ].sort();

  const header = [
    'Seat', 'Name', 'Email', 'Phone', 'Status', 'Plan', 'Paid', 'Outstanding',
    ...detailKeys.map((k) => k.replace(/_/g, ' ')),
  ];

  const lines = rows.map((r) => {
    const charges = byRegistration.get(r.id) ?? [];
    const details = (r.registrant_details ?? {}) as Record<string, string>;
    return [
      r.seat_no,
      r.registrant_name,
      r.registrant_email,
      r.registrant_phone ?? '',
      r.status,
      r.plan_name,
      (paidCentavos(charges) / 100).toFixed(2),
      (outstandingCentavos(charges) / 100).toFixed(2),
      ...detailKeys.map((k) => details[k] ?? ''),
    ];
  });

  await recordAudit(actor, {
    action: 'event.roster_exported',
    targetTable: 'events',
    targetId: eventId,
    eventId,
    note: `${rows.length} attendee${rows.length === 1 ? '' : 's'}, including ${detailKeys.length} personal-detail column${detailKeys.length === 1 ? '' : 's'}`,
  });

  const stamp = now.toISOString().slice(0, 10);
  return csvResponse(`${csvSlug(String(eventRow.title))}-roster-${stamp}.csv`, header, lines);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Loads a registration and one of its charges, or the 404 to return. */
async function loadCharge(
  supabase: SupabaseClient,
  registrationId: string,
  chargeId: string,
): Promise<{ registration: RegistrationRow; charge: ChargeRow } | null> {
  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow>();
  if (error) throw error;
  if (!registration) return null;

  const { data: charge, error: chargeError } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    // Scoped to the registration in the path, so a charge id from a different
    // registration cannot be acted on by guessing the pair.
    .eq('registration_id', registrationId)
    .eq('id', chargeId)
    .maybeSingle<ChargeRow>();
  if (chargeError) throw chargeError;
  if (!charge) return null;

  return { registration, charge };
}

/**
 * Records a payment that arrived outside PayMongo — a bank transfer, GCash, or
 * cash on the day.
 *
 * Routed through applyChargePayment rather than writing the row here, so the
 * registrant gets the same receipt and the same confirmation they would have
 * had online, and the deposit still confirms the place.
 */
async function markPaid(
  registrationId: string,
  chargeId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const method = String(body.method ?? '').trim().slice(0, 40);
  const reference = String(body.reference ?? '').trim().slice(0, 200);
  if (!method) return badRequest('How was it paid? (bank transfer, GCash, cash…)');
  if (!reference) {
    // Insisted on, not optional: an offline payment with no reference cannot be
    // matched against a bank statement later, which is the entire reason for
    // recording it here rather than in someone's inbox.
    return badRequest('A reference is required — the bank reference, receipt number, or similar.');
  }

  const paidAtRaw = body.paidAt ? new Date(String(body.paidAt)) : null;
  if (paidAtRaw && Number.isNaN(paidAtRaw.getTime())) return badRequest('That payment date is not valid.');

  const loaded = await loadCharge(supabase, registrationId, chargeId);
  if (!loaded) return notFound('Registration or payment not found');
  const { charge } = loaded;

  if (charge.status === 'paid') return conflict('That payment is already recorded as paid.');
  if (!isOutstanding(charge.status)) return conflict('That payment is no longer due.');

  const result = await applyChargePayment(chargeId, undefined, {
    method,
    reference,
    ...(paidAtRaw ? { paidAt: paidAtRaw.toISOString() } : {}),
  });

  await recordAudit(actor, {
    action: 'charge.mark_paid_offline',
    targetTable: 'registration_charges',
    targetId: registrationId,
    eventId: loaded.registration.event_id,
    amountCentavos: charge.amount_centavos,
    currency: charge.currency,
    before: { status: charge.status },
    after: { status: 'paid', method, reference },
    note: `${charge.label} received by ${method}`,
  });

  return ok({ chargeId, status: result.status, registrationConfirmed: result.registrationConfirmed });
}

/**
 * Settles a charge without money: forgiven, or cancelled as a duplicate.
 *
 * One function for both because the mechanics are identical and only the word
 * differs — and the word matters, which is why they stay separate values in
 * the enum. A waiver is money the business chose not to collect; a void is a
 * charge that should not have existed. Reporting them as one number would hide
 * the first inside the second.
 */
async function settleWithout(
  registrationId: string,
  chargeId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
  outcome: 'waived' | 'void',
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!reason) return badRequest('Why? A short reason is recorded against this.');

  const loaded = await loadCharge(supabase, registrationId, chargeId);
  if (!loaded) return notFound('Registration or payment not found');
  const { charge } = loaded;

  if (charge.status === 'paid') return conflict('That payment has already been made.');
  if (!isOutstanding(charge.status)) return conflict('That payment is no longer due.');

  const { data: claimed, error } = await supabase
    .from('registration_charges')
    .update({
      status: outcome,
      voided_at: new Date().toISOString(),
      void_reason: reason,
      flagged_at: null,
    })
    .eq('id', chargeId)
    // Compare-and-set: a payment that landed between the read above and this
    // write must win, not be overwritten by a waiver.
    .in('status', ['scheduled', 'awaiting_payment'])
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  if (!claimed) return conflict('That payment changed while you were working — reload and try again.');

  await recordAudit(actor, {
    action: outcome === 'waived' ? 'charge.waive' : 'charge.void',
    targetTable: 'registration_charges',
    targetId: registrationId,
    eventId: loaded.registration.event_id,
    // A waiver is money forgiven and belongs in the money view; a void is a
    // correction to a charge that should not have been there, and counting it
    // as forgiven revenue would be wrong.
    ...(outcome === 'waived'
      ? { amountCentavos: charge.amount_centavos, currency: charge.currency }
      : {}),
    before: { status: charge.status },
    after: { status: outcome },
    note: `${charge.label}: ${reason}`,
  });

  return ok({ chargeId, status: outcome });
}

/** The deposit charge's amount, or 0 if one is somehow absent. */
function depositCentavosOf(charges: ChargeRow[]): number {
  return charges.find((c) => c.is_deposit)?.amount_centavos ?? 0;
}

/** `nonRecoverableCentavos` from a query string or body: 0 default, or 'invalid'. */
function parseNonRecoverable(raw: unknown): number | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 'invalid';
}

/**
 * `GET /admin/registrations/{id}/refund-assessment[?nonRecoverableCentavos=]`
 *
 * The Participant Agreement §III position for cancelling this registration
 * right now, so the admin screen starts from the contract rather than a blank
 * prompt. Read-only — `cancel` recomputes it server-side and never trusts a
 * number the client sends for this.
 */
async function refundAssessment(
  registrationId: string,
  query: Record<string, string | undefined>,
): Promise<APIGatewayProxyResultV2> {
  const nonRecoverable = parseNonRecoverable(query.nonRecoverableCentavos);
  if (nonRecoverable === 'invalid') {
    return badRequest('nonRecoverableCentavos must be a whole number of centavos.');
  }

  const supabase = await getSupabase();
  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select('id, currency, status, event_id, events(starts_at)')
    .eq('id', registrationId)
    .maybeSingle<{
      id: string;
      currency: string;
      status: string;
      event_id: string;
      events: { starts_at: string } | null;
    }>();
  if (error) throw error;
  if (!registration || !registration.events) return notFound('Registration not found');

  const charges = (await chargesFor(supabase, [registrationId])).get(registrationId) ?? [];

  const assessment = assessRefund({
    eventStartsAt: registration.events.starts_at,
    now: new Date(),
    paidCentavos: paidCentavos(charges),
    depositCentavos: depositCentavosOf(charges),
    nonRecoverableCentavos: nonRecoverable,
    currency: registration.currency,
  });

  return ok({ registrationId, status: registration.status, assessment });
}

/**
 * Cancels a place and frees the seat.
 *
 * The refund is *recorded*, never executed — consistent with the standing
 * "manual revoke, no automation" rule and with how booking refunds work.
 *
 * The starting number, though, is no longer a guess: `assessRefund` applies
 * Participant Agreement §III (see event-ticketing.ts). When the caller sends
 * no `refundCentavos`, the tier's figure is used; when they send one, it wins
 * and the divergence from the tier is written to the audit trail and the
 * registration's notes. A tier-2 cancellation also produces a *credit* toward
 * a future retreat — recorded in the notes and told to the registrant, but
 * with no redemption mechanism yet, so a human still arranges it.
 */
async function cancel(
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const reason = String(body.reason ?? '').trim().slice(0, 500);
  const refundRaw = body.refundCentavos;
  const refundOverride =
    refundRaw === undefined || refundRaw === null || refundRaw === '' ? null : Number(refundRaw);
  if (refundOverride !== null && (!Number.isInteger(refundOverride) || refundOverride < 0)) {
    return badRequest('A refund must be a whole number of centavos, or left blank.');
  }
  const nonRecoverable = parseNonRecoverable(body.nonRecoverableCentavos);
  if (nonRecoverable === 'invalid') {
    return badRequest('nonRecoverableCentavos must be a whole number of centavos, or left blank.');
  }

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location, venue_details, format)`)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow & { events: Record<string, unknown> | null }>();
  if (error) throw error;
  if (!registration) return notFound('Registration not found');
  if (registration.status === 'cancelled') return conflict('That registration is already cancelled.');

  const nowDate = new Date();
  const now = nowDate.toISOString();

  // Fetched before the update: only outstanding charges are about to change,
  // and the assessment is a function of the *paid* ones, which do not.
  const charges = (await chargesFor(supabase, [registrationId])).get(registrationId) ?? [];

  const eventStartsAt = (registration.events?.starts_at as string | undefined) ?? null;
  const assessment: RefundAssessment | null = eventStartsAt
    ? assessRefund({
        eventStartsAt,
        now: nowDate,
        paidCentavos: paidCentavos(charges),
        depositCentavos: depositCentavosOf(charges),
        nonRecoverableCentavos: nonRecoverable,
        currency: registration.currency,
      })
    : null;

  const refundCentavos = refundOverride ?? assessment?.refundCentavos ?? null;
  const creditCentavos = assessment?.creditCentavos ?? 0;

  // A note is worth keeping only when something still needs a human: a credit
  // to arrange, or an override to explain. A tier-matching cash refund is
  // already fully described by the audit row.
  const overridden =
    assessment !== null && refundOverride !== null && refundOverride !== assessment.refundCentavos;
  const noteParts: string[] = [];
  if (assessment) noteParts.push(`§III ${assessment.tier}: ${assessment.summary}`);
  if (creditCentavos > 0) noteParts.push('Retreat credit to arrange manually.');
  if (overridden) {
    noteParts.push(`Refund set to ${refundCentavos} (tier suggested ${assessment!.refundCentavos}).`);
  }
  const priorNotes = typeof registration.admin_notes === 'string' ? registration.admin_notes : '';
  const adminNotes =
    creditCentavos > 0 || overridden
      ? [priorNotes, `[${now.slice(0, 10)}] ${noteParts.join(' ')}`].filter(Boolean).join('\n')
      : (priorNotes || null);

  const { data: claimed, error: updateError } = await supabase
    .from('event_registrations')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: 'admin',
      cancellation_reason: reason || null,
      cancellation_decided_at: registration.cancellation_requested_at ? now : null,
      cancellation_decision: registration.cancellation_requested_at ? 'approved' : null,
      refund_centavos: refundCentavos,
      admin_notes: adminNotes,
      hold_expires_at: null,
      flagged_at: null,
      flag_reason: null,
    })
    .eq('id', registrationId)
    .neq('status', 'cancelled')
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updateError) throw updateError;
  if (!claimed) return conflict('That registration changed while you were working — reload and try again.');

  // Nothing further is owed on a place nobody holds. Paid charges are left
  // exactly as they are: that money was received, and erasing the record of it
  // is not the same as returning it.
  await supabase
    .from('registration_charges')
    .update({ status: 'void', voided_at: now, void_reason: 'registration cancelled', flagged_at: null })
    .eq('registration_id', registrationId)
    .in('status', ['scheduled', 'awaiting_payment']);

  await recordAudit(actor, {
    action: 'registration.cancel',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    ...(refundCentavos ? { amountCentavos: refundCentavos, currency: registration.currency } : {}),
    before: { status: registration.status, seat_no: registration.seat_no },
    after: {
      status: 'cancelled',
      refund_centavos: refundCentavos,
      ...(assessment
        ? {
            refund_tier: assessment.tier,
            refund_credit_centavos: creditCentavos,
            refund_tier_suggested_centavos: assessment.refundCentavos,
          }
        : {}),
    },
    note: reason || null,
  });

  const ev = registration.events;
  if (ev) {
    await sendRegistrationCancelled({
      registrationId,
      buyerEmail: registration.buyer_email,
      registrantName: registration.registrant_name,
      event: ev as never,
      registration: registration as never,
      charges: charges as never,
      refundCentavos,
      creditCentavos: creditCentavos || null,
      reason: reason || null,
    });
  }

  return ok({
    registrationId,
    status: 'cancelled',
    seatFreed: registration.seat_no,
    refundCentavos,
    ...(assessment ? { assessment } : {}),
  });
}

/**
 * Emails a registrant about an outstanding payment.
 *
 * Carries no PayMongo link on purpose — see sendPaymentNudge. This is the
 * "have you seen this?" that comes before any harder conversation, and it is
 * audited without an amount because nothing moved.
 */
async function nudge(
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location, venue_details, format)`)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow & { events: Record<string, unknown> | null }>();
  if (error) throw error;
  if (!registration) return notFound('Registration not found');
  if (registration.status === 'cancelled') return conflict('That registration is cancelled.');

  const charges = (await chargesFor(supabase, [registrationId])).get(registrationId) ?? [];
  if (outstandingCentavos(charges) === 0) return conflict('There is nothing outstanding to chase.');
  if (!registration.events) return conflict('That event is missing.');

  const note = String(body.note ?? '').trim().slice(0, 500) || null;

  await sendPaymentNudge({
    registrationId,
    buyerEmail: registration.buyer_email,
    registrantName: registration.registrant_name,
    event: registration.events as never,
    registration: registration as never,
    charges: charges as never,
    note,
  });

  await recordAudit(actor, {
    action: 'registration.nudged',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    note: note ?? 'payment reminder sent',
  });

  return ok({ registrationId, sent: true });
}

// ---------------------------------------------------------------------------

async function auditLog(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  let builder = supabase
    .from('admin_audit_log')
    .select(
      'id, actor_source, actor_label, actor_sub, source_ip, action, target_table, target_id, ' +
        'event_id, amount_centavos, currency, before, after, note, created_at',
    );

  if (query.eventId) builder = builder.eq('event_id', query.eventId);
  if (query.targetId) builder = builder.eq('target_id', query.targetId);
  // The money view: everything that moved a number, which is the subset anyone
  // reconciling actually wants.
  if (query.money === '1') builder = builder.not('amount_centavos', 'is', null);

  const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100) || 100));

  const { data, error } = await builder.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;

  return ok({ entries: data ?? [] });
}

// ---------------------------------------------------------------------------
// The cancellation lifecycle
// ---------------------------------------------------------------------------

/**
 * Answers a registrant's own cancellation request — yes or no.
 *
 * Approving delegates to `cancel`, which is the single place a place is ever
 * given up: one path to "cancelled" means the seat is freed, the schedule
 * voided, the refund recorded and the email sent identically whether an admin
 * initiated it or a registrant asked for it.
 *
 * Declining is the branch that did not exist before this. It stamps the
 * decision and leaves everything else exactly as it was — the place stays
 * held, the schedule stays due — and it takes the request out of the admin
 * queue, because an answered request is answered whichever way it went.
 */
async function cancellationDecision(
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const decision = String(body.decision ?? '');
  if (decision !== 'approved' && decision !== 'declined') {
    return badRequest("Decision must be either 'approved' or 'declined'.");
  }

  const supabase = await getSupabase();

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location, venue_details, format)`)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow & { events: Record<string, unknown> | null }>();
  if (error) throw error;
  if (!registration) return notFound('Registration not found');

  if (!registration.cancellation_requested_at) {
    return conflict(
      'Nobody has asked to cancel this registration. Use "Cancel this place" if you need to cancel it anyway.',
    );
  }
  if (registration.cancellation_decided_at) {
    return conflict('That request has already been answered.');
  }

  if (decision === 'approved') {
    // The one path to cancelled. `cancel` already stamps decided_at and
    // decision='approved' when a request is outstanding.
    return await cancel(registrationId, body, actor);
  }

  const reason = String(body.reason ?? '').trim().slice(0, 500);
  const now = new Date().toISOString();

  const { data: claimed, error: updateError } = await supabase
    .from('event_registrations')
    .update({ cancellation_decided_at: now, cancellation_decision: 'declined' })
    .eq('id', registrationId)
    // Compare-and-set: a concurrent approval must win rather than be
    // overwritten by a decline arriving a moment later.
    .is('cancellation_decided_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updateError) throw updateError;
  if (!claimed) return conflict('That request was answered while you were working — reload and try again.');

  await recordAudit(actor, {
    action: 'registration.cancellation_declined',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    before: { cancellation_requested_at: registration.cancellation_requested_at },
    after: { cancellation_decision: 'declined' },
    note: reason || null,
  });

  const ev = registration.events as { title?: string } | null;
  if (ev?.title) {
    await sendCancellationDeclined({
      to: registration.buyer_email,
      registrantName: registration.registrant_name,
      eventTitle: ev.title,
      reason: reason || null,
    }).catch((err) => console.error('[adminRegistrations] decline email failed', err));
  }

  return ok({ registrationId, decision: 'declined' });
}

/**
 * Records that a refund has actually been sent.
 *
 * Deliberately separate from deciding the amount. `refund_centavos` is what
 * someone judged was owed; `refunded_at` is the fact that money moved, and
 * only a human moving it can assert that. Keeping them apart is what makes
 * "refunds still to send" answerable at all — the admin money view reads
 * exactly that gap.
 *
 * A reference is required for the same reason an offline payment needs one:
 * without it, this is unmatchable against a bank statement later.
 */
async function refundSent(
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const reference = String(body.reference ?? '').trim().slice(0, 200);
  if (!reference) {
    return badRequest('A reference is required — the bank reference or transfer id.');
  }

  const supabase = await getSupabase();

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow>();
  if (error) throw error;
  if (!registration) return notFound('Registration not found');

  if (!registration.refund_centavos || registration.refund_centavos <= 0) {
    return conflict('No refund is recorded against this registration.');
  }
  if (registration.refunded_at) {
    return conflict('That refund is already marked as sent.');
  }

  const { data: claimed, error: updateError } = await supabase
    .from('event_registrations')
    .update({ refunded_at: new Date().toISOString(), refund_reference: reference })
    .eq('id', registrationId)
    .is('refunded_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updateError) throw updateError;
  if (!claimed) return conflict('That refund was marked sent while you were working — reload and try again.');

  await recordAudit(actor, {
    action: 'registration.refund_sent',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    amountCentavos: registration.refund_centavos,
    currency: registration.currency,
    after: { refund_reference: reference },
    note: `refund of ${registration.refund_centavos} sent, ref ${reference}`,
  });

  return ok({ registrationId, refundedAt: new Date().toISOString(), reference });
}

/**
 * Changes what a registration costs, after the fact.
 *
 * **A paid charge is never touched.** Money that arrived is a fact; an
 * override changes only what is still owed. So: everything outstanding is
 * voided, and the difference between the new total and what has already been
 * paid becomes a single new charge.
 *
 * The awkward case is an override *below* what someone has already paid. That
 * is an overpayment, and this does not try to be clever about it — it records
 * the difference as a refund owed and leaves it in the admin's refunds queue,
 * where a human decides what actually happens. Silently voiding the excess
 * would lose the fact that Hilom is holding money it no longer has a claim to.
 */
async function priceOverride(
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const totalRaw = body.totalCentavos;
  const newTotal = Number(totalRaw);
  if (!Number.isInteger(newTotal) || newTotal < 0) {
    return badRequest('The new total must be a whole number of centavos.');
  }
  const reason = String(body.reason ?? '').trim().slice(0, 500);
  if (!reason) return badRequest('Why is the price changing? A short reason is recorded against this.');

  const supabase = await getSupabase();

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('id', registrationId)
    .maybeSingle<RegistrationRow>();
  if (error) throw error;
  if (!registration) return notFound('Registration not found');
  if (registration.status === 'cancelled') return conflict('That registration is cancelled.');

  const charges = (await chargesFor(supabase, [registrationId])).get(registrationId) ?? [];
  const paid = paidCentavos(charges);
  const outstanding = charges.filter((c) => isOutstanding(c.status));
  const now = new Date().toISOString();

  // The latest date anything was already due, so a reissued balance does not
  // silently become due sooner than what it replaced.
  const latestDue = outstanding.reduce<string | null>(
    (acc, c) => (acc === null || Date.parse(c.due_at) > Date.parse(acc) ? c.due_at : acc),
    null,
  );

  if (outstanding.length > 0) {
    const { error: voidError } = await supabase
      .from('registration_charges')
      .update({ status: 'void', voided_at: now, void_reason: `price changed: ${reason}`, flagged_at: null })
      .eq('registration_id', registrationId)
      .in('status', ['scheduled', 'awaiting_payment']);
    if (voidError) throw voidError;
  }

  const remaining = newTotal - paid;
  let reissuedChargeId: string | null = null;
  let overpaidCentavos = 0;

  if (remaining > 0) {
    const maxSeq = charges.reduce((acc, c) => Math.max(acc, c.seq), 0);
    const { data: reissued, error: insertError } = await supabase
      .from('registration_charges')
      .insert({
        registration_id: registrationId,
        event_id: registration.event_id,
        seq: maxSeq + 1,
        label: 'Adjusted balance',
        is_deposit: false,
        amount_centavos: remaining,
        currency: registration.currency,
        due_at: latestDue ?? now,
        status: 'scheduled',
      })
      .select('id')
      .maybeSingle<{ id: string }>();
    if (insertError) throw insertError;
    reissuedChargeId = reissued?.id ?? null;
  } else if (remaining < 0) {
    overpaidCentavos = -remaining;
  }

  const { error: regError } = await supabase
    .from('event_registrations')
    .update({
      total_centavos: newTotal,
      price_override_centavos: newTotal,
      price_override_reason: reason,
      // Added to whatever was already owed, not replacing it: an override
      // after a partial refund decision must not erase that decision.
      ...(overpaidCentavos > 0
        ? { refund_centavos: (registration.refund_centavos ?? 0) + overpaidCentavos }
        : {}),
    })
    .eq('id', registrationId);
  if (regError) throw regError;

  await recordAudit(actor, {
    action: 'registration.price_override',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    amountCentavos: newTotal,
    currency: registration.currency,
    before: { total_centavos: registration.total_centavos, paid_centavos: paid },
    after: {
      total_centavos: newTotal,
      voided_charges: outstanding.length,
      reissued_centavos: remaining > 0 ? remaining : 0,
      overpaid_centavos: overpaidCentavos,
    },
    note: reason,
  });

  return ok({
    registrationId,
    totalCentavos: newTotal,
    paidCentavos: paid,
    reissuedChargeId,
    overpaidCentavos,
  });
}

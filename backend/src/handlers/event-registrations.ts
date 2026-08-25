/**
 * Buyer-facing event registration.
 *
 *   POST /events/{eventId}/register
 *   GET  /me/registrations
 *   GET  /registrations/{registrationId}
 *   GET  /registrations/{registrationId}/status
 *   POST /registrations/{registrationId}/charges/{chargeId}/pay
 *   POST /registrations/{registrationId}/pay-balance
 *   PUT  /registrations/{registrationId}/registrant
 *   POST /registrations/{registrationId}/cancel-request
 *   GET  /registrations/{registrationId}/charges/{chargeId}/receipt
 *
 * Cognito-authenticated throughout: `requireBuyer` gives a verified, confirmed
 * email, which is the identity a registration is keyed on — there is no users
 * table here any more than there is for orders or bookings.
 *
 * The order of operations in `register` is the one rule that matters. The
 * registration row and its whole charge schedule are written *before* PayMongo
 * is called, inside a single RPC, so that "paid but no seat" is impossible: a
 * seat can exist without a payment (it lapses on its own) but a payment can
 * never exist without a seat to attach it to. Same principle as the standing
 * "record the money before fulfilling" rule for course orders, applied to
 * inventory instead of enrolment.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json } from '../lib/http.js';
import { requireBuyer, UnauthorizedError } from '../lib/auth.js';
import { createHostedCheckout } from '../lib/paymongo-checkout.js';
import { selfActor, recordAudit } from '../lib/audit.js';
import { sendAttendeeTransferred, sendCancellationRequested, sendCancellationRequestedAdminAlert } from '../lib/registration-email.js';
import {
  buildSchedule,
  activePlans,
  validateRegistrant,
  registrationOpen,
  TicketingValidationError,
  isOutstanding,
  nextDueCharge,
  outstandingCentavos,
  paidCentavos,
  isFullySettled,
  type PaymentPlan,
  type PlanInstallment,
  type ChargeStatus,
} from '../lib/event-ticketing.js';

/** 409 — the request was well-formed but the world moved. */
const conflict = (message: string) => json(409, { error: message });

/**
 * What `claim_event_seat` raises, and what each means to the person waiting.
 *
 * Mapped rather than passed through: the function raises stable machine codes
 * precisely so the wording can live here, next to the HTTP status, instead of
 * inside a migration.
 */
const CLAIM_ERRORS: Record<string, { status: number; message: string }> = {
  sold_out: {
    status: 409,
    message: 'Those places have just been taken. Nothing has been charged.',
  },
  registration_closed: { status: 409, message: 'Registration for this event has closed.' },
  registration_not_open: { status: 409, message: 'Registration for this event has not opened yet.' },
  ticketing_closed: { status: 404, message: 'This event is not open for registration.' },
  capacity_not_configured: {
    status: 409,
    message: 'This event is not ready to take registrations yet.',
  },
  plan_not_available: {
    status: 409,
    message: 'That payment option is no longer available. Please choose another.',
  },
  charge_total_mismatch: {
    status: 409,
    message: 'The price changed while you were filling this in. Please start again.',
  },
  event_not_found: { status: 404, message: 'Event not found' },
};

interface EventRow {
  id: string;
  title: string;
  slug?: string | null;
  status: string;
  ticketing_enabled: boolean;
  capacity: number | null;
  currency: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  hold_minutes: number;
  registrant_fields: string[];
}

const EVENT_COLUMNS =
  'id, title, status, ticketing_enabled, capacity, currency, registration_opens_at, ' +
  'registration_closes_at, hold_minutes, registrant_fields';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  let buyer;
  try {
    buyer = await requireBuyer(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('eventRegistrations.auth', err);
  }

  try {
    // Every branch is awaited rather than returned: a returned pending promise
    // escapes this try before rejecting, turning a validation error into an
    // uncaught Lambda rejection.
    const eventId = event.pathParameters?.eventId;
    const registrationId = event.pathParameters?.registrationId;

    const chargeId = event.pathParameters?.chargeId;

    if (eventId && method === 'POST' && path.endsWith('/register')) {
      return await register(event, eventId, buyer);
    }
    if (method === 'GET' && path.endsWith('/me/registrations')) {
      return await listMine(buyer.email);
    }
    if (registrationId && method === 'GET' && path.endsWith('/status')) {
      return await status(registrationId, buyer.email);
    }
    if (registrationId && chargeId && method === 'POST' && path.endsWith('/pay')) {
      return await payCharge(registrationId, chargeId, buyer);
    }
    if (registrationId && method === 'POST' && path.endsWith('/pay-balance')) {
      return await payBalance(registrationId, buyer);
    }
    if (registrationId && method === 'PUT' && path.endsWith('/registrant')) {
      return await updateRegistrant(event, registrationId, buyer);
    }
    if (registrationId && method === 'POST' && path.endsWith('/cancel-request')) {
      return await requestCancellation(event, registrationId, buyer.email);
    }
    if (registrationId && chargeId && method === 'GET' && path.endsWith('/receipt')) {
      return await receipt(registrationId, chargeId, buyer.email);
    }
    // Bare /registrations/{id} last: every literal-suffixed route above would
    // also match this one's shape.
    if (registrationId && method === 'GET') {
      return await detail(registrationId, buyer.email);
    }

    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    if (err instanceof TicketingValidationError) return badRequest(err.message);
    return serverError('eventRegistrations', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new TicketingValidationError('Request body is not valid JSON');
  }
}

async function register(
  event: APIGatewayProxyEventV2,
  eventId: string,
  buyer: { sub: string; email: string; givenName?: string | undefined; familyName?: string | undefined },
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const planId = String(body.planId ?? '');
  if (!planId) return badRequest('Choose how you would like to pay.');

  const supabase = await getSupabase();

  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select(EVENT_COLUMNS)
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (eventError) throw eventError;
  if (!eventRow || !eventRow.ticketing_enabled || eventRow.status !== 'published') {
    return notFound('This event is not open for registration.');
  }

  const now = new Date();

  // Checked here for a readable message, and again inside claim_event_seat
  // under the row lock — which is the check that actually decides, since this
  // one is stale the moment it returns.
  if (
    !registrationOpen({
      ticketingEnabled: eventRow.ticketing_enabled,
      status: eventRow.status,
      opensAt: eventRow.registration_opens_at,
      closesAt: eventRow.registration_closes_at,
      now,
    })
  ) {
    return conflict('Registration for this event is not open.');
  }

  const registrant = validateRegistrant({
    requestedFields: eventRow.registrant_fields ?? [],
    body: (body.registrant ?? {}) as Record<string, unknown>,
  });

  const { data: plans, error: planError } = await supabase
    .from('event_payment_plans')
    .select('id, name, kind, total_centavos, currency, available_from, available_until, is_active, sort_order')
    .eq('event_id', eventId)
    .returns<PaymentPlan[]>();
  if (planError) throw planError;

  const plan = activePlans(plans ?? [], now).find((candidate) => candidate.id === planId);
  if (!plan) return conflict('That payment option is no longer available. Please choose another.');

  const { data: installments, error: instError } = await supabase
    .from('event_plan_installments')
    .select('seq, label, amount_centavos, due_at, due_offset_days, is_deposit')
    .eq('plan_id', plan.id)
    .order('seq', { ascending: true })
    .returns<PlanInstallment[]>();
  if (instError) throw instError;

  // The schedule is computed here, unit-tested, and recorded by the RPC — the
  // database re-checks only that it sums to the plan total, so this is the one
  // place the dates and the rounding are decided.
  const charges = buildSchedule({
    plan,
    installments: installments ?? [],
    now,
    holdMinutes: eventRow.hold_minutes ?? 60,
  });

  const { data: registrationId, error: claimError } = await supabase.rpc('claim_event_seat', {
    p_event_id: eventId,
    p_plan_id: plan.id,
    p_buyer_email: buyer.email,
    p_buyer_sub: buyer.sub,
    p_registrant: {
      name: registrant.name,
      email: registrant.email,
      phone: registrant.phone ?? null,
      details: registrant.details,
    },
    p_charges: charges,
    p_hold_minutes: eventRow.hold_minutes ?? 60,
  });

  if (claimError) {
    const known = Object.entries(CLAIM_ERRORS).find(([code]) => claimError.message?.includes(code));
    if (known) {
      const [, mapped] = known;
      return json(mapped.status, { error: mapped.message });
    }
    throw claimError;
  }

  const newRegistrationId = String(registrationId);

  const { data: deposit, error: depositError } = await supabase
    .from('registration_charges')
    .select('id, amount_centavos, currency, label')
    .eq('registration_id', newRegistrationId)
    .eq('is_deposit', true)
    .maybeSingle<{ id: string; amount_centavos: number; currency: string; label: string }>();
  if (depositError) throw depositError;
  if (!deposit) throw new Error(`Registration ${newRegistrationId} has no deposit charge`);

  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';
  const buyerName = [buyer.givenName, buyer.familyName].filter(Boolean).join(' ') || registrant.name;

  let session;
  try {
    session = await createHostedCheckout({
      name: `${eventRow.title} — ${plan.name}`,
      description: eventRow.title,
      amountCentavos: deposit.amount_centavos,
      currency: deposit.currency,
      billing: { email: buyer.email, name: buyerName },
      metadata: {
        kind: 'event_registration',
        charge_id: deposit.id,
        registration_id: newRegistrationId,
        buyer_email: buyer.email,
      },
      successUrl: `${origin}/events/registration/processing`,
      cancelUrl: `${origin}/events`,
    });
  } catch (err) {
    // Free the seat immediately rather than leaving it parked for the whole
    // hold over a failure that had nothing to do with the registrant. Same
    // reasoning as the booking flow, expressed as a status change because
    // expired registrations are kept (they are a sales lead, not noise).
    await supabase
      .from('event_registrations')
      .update({ status: 'expired', error_detail: 'checkout session could not be created' })
      .eq('id', newRegistrationId)
      .eq('status', 'pending_payment');
    return serverError('eventRegistrations.register', err);
  }

  const holdExpiresAt = new Date(now.getTime() + (eventRow.hold_minutes ?? 60) * 60_000).toISOString();

  await supabase
    .from('registration_charges')
    .update({
      paymongo_session_id: session.sessionId,
      checkout_url: session.checkoutUrl,
      checkout_expires_at: holdExpiresAt,
    })
    .eq('id', deposit.id);

  return ok({
    registrationId: newRegistrationId,
    chargeId: deposit.id,
    checkoutUrl: session.checkoutUrl,
    amountCentavos: deposit.amount_centavos,
    currency: deposit.currency,
    holdExpiresAt,
    planName: plan.name,
    totalCentavos: plan.total_centavos,
  });
}

/**
 * Polled by the confirmation screen while the webhook lands, mirroring
 * `bookings.status` and `orders.statusBySession`.
 *
 * Ownership-checked, and a registration belonging to someone else returns 404
 * rather than 403 — the same choice the booking flow makes, so that the
 * endpoint cannot be used to discover which ids exist.
 *
 * Note the absence of `seat_no`: the number is real and useful on the admin
 * roster, but showing a buyer they are "seat 13 of 13" implies an ordering
 * nobody intended to publish.
 */
async function status(registrationId: string, email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('event_registrations')
    .select('id, status, buyer_email, plan_name, total_centavos, currency, events(title, starts_at, location)')
    .eq('id', registrationId)
    .maybeSingle<{
      id: string;
      status: string;
      buyer_email: string;
      plan_name: string;
      total_centavos: number;
      currency: string;
      events: { title: string; starts_at: string; location: string | null } | null;
    }>();

  if (error) throw error;
  if (!data || data.buyer_email.toLowerCase() !== email.toLowerCase()) {
    return notFound('Registration not found');
  }

  return ok({
    registrationId: data.id,
    status: data.status,
    planName: data.plan_name,
    totalCentavos: data.total_centavos,
    currency: data.currency,
    eventTitle: data.events?.title ?? null,
    startsAt: data.events?.starts_at ?? null,
    location: data.events?.location ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reading your own registrations
// ---------------------------------------------------------------------------

const CHARGE_COLUMNS =
  'id, seq, label, is_deposit, amount_centavos, currency, due_at, status, paid_at, receipt_no, ' +
  'checkout_url, checkout_expires_at';

/** For the admin nudge sent when a registrant asks to cancel. */
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;

/**
 * Columns safe to hand a buyer.
 *
 * `seat_no` is deliberately absent: the number is real and useful on the admin
 * roster, but telling someone they are "seat 13 of 13" publishes an ordering
 * nobody intended. Same for admin_notes and the flag columns — an internal
 * note about a registration is not the registrant's to read.
 */
const OWN_REGISTRATION_COLUMNS =
  'id, event_id, status, buyer_email, registrant_name, registrant_email, registrant_phone, ' +
  'registrant_details, plan_name, plan_kind, total_centavos, currency, hold_expires_at, ' +
  'confirmed_at, cancellation_requested_at, cancellation_decided_at, cancellation_decision, created_at';

interface OwnedRegistration extends Record<string, unknown> {
  id: string;
  buyer_email: string;
  status: string;
  plan_kind: 'full' | 'installment';
  currency: string;
}

/** What loadOwned selects: the owned row plus the two joins both payers need. */
interface OwnedForPayment extends OwnedRegistration {
  event_id: string;
  events: { title: string } | null;
}

interface ChargeRow extends Record<string, unknown> {
  id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: ChargeStatus;
  checkout_url: string | null;
  checkout_expires_at: string | null;
}

/** Everything the account view needs, newest first. */
async function listMine(email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location, image_url)`)
    .eq('buyer_email', email.toLowerCase())
    // An expired hold is not something anyone wants listed back at them as if
    // it were a booking. The row is kept (it is a sales lead) but it is not
    // part of "my registrations".
    .neq('status', 'expired')
    .order('created_at', { ascending: false })
    .returns<OwnedRegistration[]>();
  if (error) throw error;

  const registrations = data ?? [];
  if (registrations.length === 0) return ok({ registrations: [] });

  const { data: charges, error: chargeError } = await supabase
    .from('registration_charges')
    .select(`${CHARGE_COLUMNS}, registration_id`)
    .in('registration_id', registrations.map((r) => r.id))
    .order('seq', { ascending: true })
    .returns<(ChargeRow & { registration_id: string })[]>();
  if (chargeError) throw chargeError;

  const byRegistration = new Map<string, ChargeRow[]>();
  for (const charge of charges ?? []) {
    byRegistration.set(charge.registration_id, [...(byRegistration.get(charge.registration_id) ?? []), charge]);
  }

  return ok({
    registrations: registrations.map((r) => withTotals(r, byRegistration.get(r.id) ?? [])),
  });
}

/** One registration, ownership-checked. */
async function detail(registrationId: string, email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location, image_url, venue_details, registrant_fields)`)
    .eq('id', registrationId)
    .maybeSingle<OwnedRegistration>();
  if (error) throw error;

  // 404 rather than 403 for someone else's registration, the same choice the
  // booking flow makes: a 403 confirms the id exists, which turns this into a
  // way to discover them.
  if (!data || data.buyer_email.toLowerCase() !== email.toLowerCase()) {
    return notFound('Registration not found');
  }

  const { data: charges, error: chargeError } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    .eq('registration_id', registrationId)
    .order('seq', { ascending: true })
    .returns<ChargeRow[]>();
  if (chargeError) throw chargeError;

  return ok({ registration: withTotals(data, charges ?? []) });
}

/**
 * Attaches the derived money figures every view needs.
 *
 * Computed here from the charge rows rather than stored, because they are a
 * pure function of the ledger and a stored copy would be one more thing that
 * can disagree with it. The three functions come from event-ticketing.ts, so
 * the buyer view, the admin roster and the emails all answer "what is still
 * owed?" identically.
 */
function withTotals(registration: OwnedRegistration, charges: ChargeRow[]): Record<string, unknown> {
  const next = nextDueCharge(charges);
  return {
    ...registration,
    charges,
    paidCentavos: paidCentavos(charges),
    outstandingCentavos: outstandingCentavos(charges),
    fullySettled: isFullySettled(charges),
    // Which charge the buyer is allowed to pay next — the UI should offer this
    // one and nothing else. Null once everything is settled.
    nextChargeId: next?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

/**
 * Loads a registration the caller owns, or returns the 404 to send back.
 *
 * Both payment paths need exactly this, and both must not leak whether an id
 * exists, so the check lives in one place rather than being repeated with a
 * chance of one copy being laxer than the other.
 */
async function loadOwned(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  registrationId: string,
  email: string,
): Promise<{ registration: OwnedForPayment; charges: ChargeRow[] } | null> {
  const { data, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, event_id, events(title)`)
    .eq('id', registrationId)
    .maybeSingle<OwnedForPayment>();
  if (error) throw error;
  if (!data || data.buyer_email.toLowerCase() !== email.toLowerCase()) return null;

  const { data: charges, error: chargeError } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    .eq('registration_id', registrationId)
    .order('seq', { ascending: true })
    .returns<ChargeRow[]>();
  if (chargeError) throw chargeError;

  return { registration: data, charges: charges ?? [] };
}

/** A live hosted-checkout URL, or null if there is none worth reusing. */
function liveCheckout(charge: ChargeRow, now: Date): string | null {
  if (!charge.checkout_url) return null;
  if (!charge.checkout_expires_at) return null;
  return Date.parse(charge.checkout_expires_at) > now.getTime() ? charge.checkout_url : null;
}

/**
 * How long a hosted checkout for an instalment stays open.
 *
 * Not the event's hold_minutes: that number exists to decide how long an
 * *unpaid place* blocks someone else, and a confirmed registrant's place is
 * not at stake here. An hour is simply long enough to finish a QR Ph payment
 * and short enough that an abandoned session frees the charge to be paid again
 * the same afternoon.
 */
const INSTALLMENT_CHECKOUT_MINUTES = 60;

/**
 * Opens a checkout for one scheduled instalment.
 *
 * Two rules, both about not creating a second way to pay the same money:
 *
 *  * **Only the lowest unpaid charge may be paid.** Paying instalment four
 *    before two is legal money and an illegible ledger, and it breaks the
 *    reminder tiers, which assume the outstanding set is a suffix of the
 *    schedule rather than an arbitrary subset.
 *
 *  * **A live session is reused, never replaced.** Two open sessions for one
 *    charge are two ways to pay it, and the second payment has no charge left
 *    to attach to — it lands as an unmatched payment for an admin to chase.
 */
async function payCharge(
  registrationId: string,
  chargeId: string,
  buyer: { email: string; givenName?: string | undefined; familyName?: string | undefined },
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const owned = await loadOwned(supabase, registrationId, buyer.email);
  if (!owned) return notFound('Registration not found');
  const { registration, charges } = owned;

  if (registration.status === 'cancelled') {
    return conflict('This registration was cancelled. Get in touch if that is not what you expected.');
  }

  const charge = charges.find((c) => c.id === chargeId);
  if (!charge) return notFound('That payment is not part of this registration.');

  if (charge.status === 'paid') {
    return conflict('That payment has already been made.');
  }
  if (!isOutstanding(charge.status)) {
    return conflict('That payment is no longer due.');
  }

  const next = nextDueCharge(charges);
  if (next && next.id !== charge.id) {
    return conflict(
      `Please settle "${next.label}" first — payments are made in order.`,
    );
  }

  const now = new Date();

  const existing = liveCheckout(charge, now);
  if (existing) {
    return ok({
      chargeId: charge.id,
      checkoutUrl: existing,
      amountCentavos: charge.amount_centavos,
      currency: charge.currency,
      reused: true,
    });
  }

  const session = await openCheckoutForCharge({
    supabase,
    registrationId,
    charge,
    eventTitle: (registration as { events?: { title: string } | null }).events?.title ?? 'Hilom event',
    label: charge.label,
    amountCentavos: charge.amount_centavos,
    buyer,
    now,
  });

  return ok({
    chargeId: charge.id,
    checkoutUrl: session.checkoutUrl,
    amountCentavos: charge.amount_centavos,
    currency: charge.currency,
    reused: false,
  });
}

/**
 * Settles everything outstanding in one payment.
 *
 * Implemented as a **new charge** rather than as one session covering several
 * existing ones, and that is the whole design. A single payment can only carry
 * one `charge_id` in its metadata, so paying four charges with one session
 * would need the webhook to fan out across a list — a second code path, and a
 * second way for a partial failure to leave the ledger half-applied.
 *
 * Instead: one new charge for the outstanding amount, and the charges it
 * supersedes are voided **only when it clears** (in registration-fulfillment),
 * never here. An abandoned payoff therefore leaves the original schedule
 * completely intact, still due on its original dates.
 */
async function payBalance(
  registrationId: string,
  buyer: { email: string; givenName?: string | undefined; familyName?: string | undefined },
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const owned = await loadOwned(supabase, registrationId, buyer.email);
  if (!owned) return notFound('Registration not found');
  const { registration, charges } = owned;

  if (registration.status === 'cancelled') {
    return conflict('This registration was cancelled. Get in touch if that is not what you expected.');
  }
  if (registration.status === 'pending_payment') {
    return conflict('Your deposit has not cleared yet — settle that first.');
  }

  const outstanding = charges.filter((c) => isOutstanding(c.status));
  if (outstanding.length === 0) {
    return conflict('There is nothing left to pay.');
  }

  const now = new Date();

  // Already mid-payoff: reuse rather than minting a second balance charge,
  // which would double-count what is owed on the account screen.
  const openBalance = outstanding.find((c) => !c.is_deposit && liveCheckout(c, now));
  if (openBalance) {
    return ok({
      chargeId: openBalance.id,
      checkoutUrl: liveCheckout(openBalance, now),
      amountCentavos: openBalance.amount_centavos,
      currency: openBalance.currency,
      reused: true,
    });
  }

  // A single outstanding charge is not a "balance" — it is that charge, and
  // routing it through the supersede machinery would void a row only to
  // recreate an identical one.
  if (outstanding.length === 1) {
    return await payCharge(registrationId, outstanding[0]!.id, buyer);
  }

  const total = outstanding.reduce((acc, c) => acc + c.amount_centavos, 0);
  const maxSeq = charges.reduce((acc, c) => Math.max(acc, c.seq), 0);
  const currency = outstanding[0]!.currency;

  // Which charges this one stands in for, decided now rather than at
  // fulfillment: by the time the payment clears the outstanding set could look
  // different, and this payment covers what was outstanding when it was made.
  const supersedes = outstanding.map((c) => c.id);

  const { data: balanceCharge, error: insertError } = await supabase
    .from('registration_charges')
    .insert({
      registration_id: registrationId,
      event_id: registration.event_id,
      seq: maxSeq + 1,
      label: 'Balance payment',
      is_deposit: false,
      amount_centavos: total,
      currency,
      // Due now: this charge exists because someone chose to pay it today.
      due_at: now.toISOString(),
      status: 'awaiting_payment',
      // Recorded on the row, not only in PayMongo metadata: the retry consumer
      // and an admin's offline mark-paid both settle charges without ever
      // seeing that metadata, and all three paths must void the same rows.
      supersedes,
    })
    .select(CHARGE_COLUMNS)
    .maybeSingle<ChargeRow>();
  if (insertError) throw insertError;
  if (!balanceCharge) throw new Error('balance charge was not created');

  let session;
  try {
    session = await openCheckoutForCharge({
      supabase,
      registrationId,
      charge: balanceCharge,
      eventTitle: registration.events?.title ?? 'Hilom event',
      label: 'Balance payment',
      amountCentavos: total,
      buyer,
      now,
    });
  } catch (err) {
    // Remove the charge rather than leaving a phantom "Balance payment" on the
    // schedule for a checkout that was never opened.
    await supabase.from('registration_charges').delete().eq('id', balanceCharge.id).eq('status', 'awaiting_payment');
    return serverError('eventRegistrations.payBalance', err);
  }

  return ok({
    chargeId: balanceCharge.id,
    checkoutUrl: session.checkoutUrl,
    amountCentavos: total,
    currency,
    reused: false,
  });
}

/** Opens a PayMongo session for one charge and records it on the row. */
async function openCheckoutForCharge(input: {
  supabase: Awaited<ReturnType<typeof getSupabase>>;
  registrationId: string;
  charge: ChargeRow;
  eventTitle: string;
  label: string;
  amountCentavos: number;
  buyer: { email: string; givenName?: string | undefined; familyName?: string | undefined };
  now: Date;
}): Promise<{ checkoutUrl: string }> {
  const { supabase, registrationId, charge, eventTitle, label, amountCentavos, buyer, now } = input;

  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';
  const buyerName = [buyer.givenName, buyer.familyName].filter(Boolean).join(' ') || undefined;

  const session = await createHostedCheckout({
    name: `${eventTitle} — ${label}`,
    description: eventTitle,
    amountCentavos,
    currency: charge.currency,
    billing: { email: buyer.email, name: buyerName },
    metadata: {
      kind: 'event_registration',
      charge_id: charge.id,
      registration_id: registrationId,
      buyer_email: buyer.email,
    },
    successUrl: `${origin}/events/registration/processing?registrationId=${registrationId}`,
    cancelUrl: `${origin}/account/registrations/${registrationId}`,
  });

  const expiresAt = new Date(now.getTime() + INSTALLMENT_CHECKOUT_MINUTES * 60_000).toISOString();

  await supabase
    .from('registration_charges')
    .update({
      status: 'awaiting_payment',
      paymongo_session_id: session.sessionId,
      checkout_url: session.checkoutUrl,
      checkout_expires_at: expiresAt,
    })
    .eq('id', charge.id)
    // Only a still-payable charge may be moved: a concurrent webhook that just
    // marked this paid must not be walked back into awaiting_payment.
    .in('status', ['scheduled', 'awaiting_payment']);

  return session;
}

// ---------------------------------------------------------------------------
// Editing your own registrant details — and, when the identity changes, a
// self-service transfer.
// ---------------------------------------------------------------------------

interface RegistrantEditRow extends OwnedRegistration {
  event_id: string;
  registrant_name: string;
  registrant_email: string;
  registrant_phone: string | null;
  registrant_details: Record<string, string>;
  events: { title: string; starts_at: string; registrant_fields: string[] } | null;
}

/**
 * Updates who is attending, and what the event asked them for.
 *
 * A **transfer** — the name or email changing — is not a separate endpoint,
 * because the attendee record is one thing whether three characters of a
 * phone number change or the whole person does. What differs is the guard and
 * the notification: changing who is attending is blocked once the event has
 * started (there is no one left to hand a place to mid-retreat), and it emails
 * *both* the outgoing and incoming attendee, because the roster is printed and
 * handed to a venue — a silent change to who is coming is a safety issue, not
 * only a data one. A dietary note or a phone number changing is neither
 * blocked nor announced; it is simply saved.
 */
async function updateRegistrant(
  event: APIGatewayProxyEventV2,
  registrationId: string,
  buyer: { email: string },
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const body = parseBody(event);

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, event_id, events(title, starts_at, registrant_fields)`)
    .eq('id', registrationId)
    .maybeSingle<RegistrantEditRow>();
  if (error) throw error;
  if (!registration || registration.buyer_email.toLowerCase() !== buyer.email.toLowerCase()) {
    return notFound('Registration not found');
  }
  if (registration.status === 'cancelled' || registration.status === 'expired') {
    return conflict('This registration is no longer active.');
  }

  const next = validateRegistrant({
    requestedFields: registration.events?.registrant_fields ?? [],
    body: (body.registrant ?? body) as Record<string, unknown>,
  });

  const identityChanged =
    next.name.trim().toLowerCase() !== registration.registrant_name.trim().toLowerCase() ||
    next.email.toLowerCase() !== registration.registrant_email.toLowerCase();

  if (identityChanged) {
    const startsAt = registration.events?.starts_at;
    if (startsAt && Date.parse(startsAt) <= Date.now()) {
      return conflict(
        'This event has already started, so the place can no longer be handed to someone else. ' +
          'Write to kumusta@hilomcollective.com if you need help.',
      );
    }
  }

  const before = {
    name: registration.registrant_name,
    email: registration.registrant_email,
    phone: registration.registrant_phone,
    details: registration.registrant_details,
  };

  const { data: updated, error: updateError } = await supabase
    .from('event_registrations')
    .update({
      registrant_name: next.name,
      registrant_email: next.email,
      registrant_phone: next.phone ?? null,
      registrant_details: next.details,
      ...(identityChanged ? { transferred_at: new Date().toISOString() } : {}),
    })
    .eq('id', registrationId)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updateError) throw updateError;
  if (!updated) return notFound('Registration not found');

  await recordAudit(selfActor(buyer.email, event), {
    action: identityChanged ? 'registration.transferred' : 'registration.registrant_updated',
    targetTable: 'event_registrations',
    targetId: registrationId,
    eventId: registration.event_id,
    before,
    after: { name: next.name, email: next.email, phone: next.phone ?? null, details: next.details },
  });

  if (identityChanged && registration.events) {
    // Best-effort, and to both addresses: the person stepping back should know
    // their place was handed off, and the person stepping in should know it
    // was intentional and not a mistake landing in their inbox.
    await sendAttendeeTransferred({
      eventTitle: registration.events.title,
      oldName: registration.registrant_name,
      oldEmail: registration.registrant_email,
      newName: next.name,
      newEmail: next.email,
    }).catch((err) => console.error('[eventRegistrations] transfer email failed', err));
  }

  return ok({ registrationId, transferred: identityChanged });
}

// ---------------------------------------------------------------------------
// Requesting cancellation
// ---------------------------------------------------------------------------

/**
 * Records that a registrant wants to cancel. Nothing else.
 *
 * Sets `cancellation_requested_at` and the reason, full stop — never `status`,
 * never `hold_expires_at`. The seat stays exactly as held as it was a moment
 * ago, because the decision belongs to an admin (Phase 5's cancel endpoint),
 * and a request is not yet a decision.
 */
async function requestCancellation(
  event: APIGatewayProxyEventV2,
  registrationId: string,
  email: string,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const body = parseBody(event);
  const reason = String(body.reason ?? '').trim().slice(0, 500) || null;

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, event_id, events(title, starts_at, ends_at, location)`)
    .eq('id', registrationId)
    .maybeSingle<
      OwnedRegistration & {
        event_id: string;
        cancellation_requested_at: string | null;
        events: { title: string; starts_at: string; ends_at: string | null; location: string | null } | null;
      }
    >();
  if (error) throw error;
  if (!registration || registration.buyer_email.toLowerCase() !== email.toLowerCase()) {
    return notFound('Registration not found');
  }
  if (registration.status === 'cancelled') return conflict('This registration is already cancelled.');
  if (registration.status === 'expired') return conflict('This registration is no longer active.');
  if (registration.cancellation_requested_at) {
    return conflict("You've already asked to cancel — someone will be in touch.");
  }

  const { data: claimed, error: updateError } = await supabase
    .from('event_registrations')
    .update({ cancellation_requested_at: new Date().toISOString(), cancellation_reason: reason })
    .eq('id', registrationId)
    .is('cancellation_requested_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updateError) throw updateError;
  if (!claimed) return conflict("You've already asked to cancel — someone will be in touch.");

  if (registration.events) {
    await sendCancellationRequested({
      to: registration.buyer_email,
      registrantName: (registration as unknown as { registrant_name: string }).registrant_name,
      eventTitle: registration.events.title,
    }).catch((err) => console.error('[eventRegistrations] cancellation-requested email failed', err));

    if (ADMIN_ALERT_EMAIL) {
      await sendCancellationRequestedAdminAlert({
        to: ADMIN_ALERT_EMAIL,
        registrationId,
        registrantName: (registration as unknown as { registrant_name: string }).registrant_name,
        eventTitle: registration.events.title,
        reason,
      }).catch((err) => console.error('[eventRegistrations] cancellation admin alert failed', err));
    }
  }

  return ok({ registrationId, cancellationRequested: true });
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

interface ReceiptChargeRow {
  id: string;
  label: string;
  amount_centavos: number;
  currency: string;
  paid_at: string | null;
  paid_method: string | null;
  receipt_no: string | null;
  status: ChargeStatus;
}

/**
 * One payment's receipt, ownership-checked through the registration.
 *
 * Only ever answers for a charge that is actually `paid` — there is nothing to
 * receipt for money that has not arrived, and returning one would look like
 * proof of a payment that never happened.
 */
async function receipt(
  registrationId: string,
  chargeId: string,
  email: string,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: registration, error } = await supabase
    .from('event_registrations')
    .select(`${OWN_REGISTRATION_COLUMNS}, events(title, starts_at, ends_at, location)`)
    .eq('id', registrationId)
    .maybeSingle<
      OwnedRegistration & {
        registrant_name: string;
        events: { title: string; starts_at: string; ends_at: string | null; location: string | null } | null;
      }
    >();
  if (error) throw error;
  if (!registration || registration.buyer_email.toLowerCase() !== email.toLowerCase()) {
    return notFound('Registration not found');
  }

  const { data: charge, error: chargeError } = await supabase
    .from('registration_charges')
    .select('id, label, amount_centavos, currency, paid_at, paid_method, receipt_no, status')
    .eq('registration_id', registrationId)
    .eq('id', chargeId)
    .maybeSingle<ReceiptChargeRow>();
  if (chargeError) throw chargeError;
  if (!charge || charge.status !== 'paid') return notFound('No receipt for this payment yet.');

  return ok({
    receiptNo: charge.receipt_no,
    label: charge.label,
    amountCentavos: charge.amount_centavos,
    currency: charge.currency,
    paidAt: charge.paid_at,
    paidMethod: charge.paid_method,
    registrantName: registration.registrant_name,
    buyerEmail: registration.buyer_email,
    event: registration.events,
  });
}

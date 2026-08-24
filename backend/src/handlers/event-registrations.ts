/**
 * Buyer-facing event registration.
 *
 *   POST /events/{eventId}/register
 *   GET  /registrations/{registrationId}/status
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
import {
  buildSchedule,
  activePlans,
  validateRegistrant,
  registrationOpen,
  TicketingValidationError,
  type PaymentPlan,
  type PlanInstallment,
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

    if (eventId && method === 'POST' && path.endsWith('/register')) {
      return await register(event, eventId, buyer);
    }
    if (registrationId && method === 'GET' && path.endsWith('/status')) {
      return await status(registrationId, buyer.email);
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

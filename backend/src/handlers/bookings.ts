/**
 * Client-facing bookings.
 *
 *   POST /bookings
 *   GET  /bookings/{bookingId}/status
 *   POST /bookings/{bookingId}/cancel
 *   POST /bookings/{bookingId}/reschedule
 *   GET  /me/bookings
 *
 * The request body for a new booking carries a facilitator slug, a service id
 * and a start time — and nothing else. Price, duration, fee split, the buyer's
 * email and the meeting URL are all read server-side, for the same reason
 * `checkout.ts` refuses to take a price from the body: anything the client can
 * name, the client can lie about. Here that would mean booking a ₱2,000 session
 * for ₱0, or provisioning a session on someone else's account.
 *
 * The write order mirrors the course flow deliberately. The booking row is
 * inserted, holding its slot, *before* the buyer is sent to PayMongo — so a
 * payment can never arrive for a booking that does not exist, and an abandoned
 * checkout is a lapsed hold rather than a lost sale.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getPayMongoSecret } from '../lib/secrets.js';
import { ok, json, notFound, badRequest, unauthorized, serverError } from '../lib/http.js';
import { requireUser, UnauthorizedError } from '../lib/auth.js';
import {
  SERVICE_PUBLIC_COLUMNS,
  releaseExpiredHolds,
  verifySlot,
  holdExpiry,
  type ServiceRow,
  type FacilitatorSchedulingRow,
} from '../lib/scheduling.js';
import {
  splitFee,
  refundForCancellation,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
  type BookingStatus,
} from '../lib/booking-domain.js';
import { confirmBooking } from '../lib/booking-fulfillment.js';
import { sendBookingCancelled, sendBookingRescheduled } from '../lib/booking-email.js';

const PAYMENT_METHODS = (process.env.CHECKOUT_PAYMENT_METHODS ?? 'qrph')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 409 — the request was well-formed but the world moved. */
const conflict = (message: string) => json(409, { error: message });

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let user;
  try {
    user = await requireUser(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('bookings.auth', err);
  }

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const bookingId = event.pathParameters?.bookingId;

  try {
    if (path.endsWith('/me/bookings')) return listMine(user.email);
    if (!bookingId) {
      if (method === 'POST') return create(event, user);
      return badRequest(`Unsupported method ${method}`);
    }
    if (path.endsWith('/status')) return status(bookingId, user.email);
    if (path.endsWith('/cancel')) return cancel(bookingId, user.email);
    if (path.endsWith('/reschedule')) return reschedule(bookingId, user.email, event);
    return notFound();
  } catch (err) {
    return serverError('bookings', err);
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

const BOOKING_COLUMNS =
  'id, facilitator_id, service_id, service_kind, client_email, client_name, client_notes, starts_at, ends_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, meeting_url, paymongo_session_id, hold_expires_at, cancelled_at, cancelled_by, cancellation_reason, refund_centavos, created_at';

/**
 * The embedded relations a mutating booking path needs.
 *
 * Written out rather than derived from `SERVICE_PUBLIC_COLUMNS`: building this
 * by filtering that string produced duplicate columns and broke silently the
 * moment either list changed. These are the fields `verifySlot` and the
 * notification emails actually read, and nothing else.
 */
const BOOKING_FACILITATOR_COLUMNS =
  'id, slug, email, display_name, timezone, vacation_until, status, platform_fee_bps';

const BOOKING_SERVICE_COLUMNS =
  'id, title, duration_minutes, buffer_minutes, min_notice_minutes, max_advance_days, max_per_day, price_centavos, currency, kind, meeting_url';

/**
 * Loads facilitator + service together, both scoped to a published profile.
 *
 * The service is matched on facilitator id as well as its own, so a service id
 * lifted from another profile cannot be booked against these hours at that
 * facilitator's price.
 */
async function loadTarget(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  slug: string,
  serviceId: string,
) {
  const { data: facilitator, error } = await supabase
    .from('facilitators')
    .select('id, timezone, vacation_until, status, email, display_name, slug, platform_fee_bps')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle<
      FacilitatorSchedulingRow & {
        email: string;
        display_name: string;
        slug: string;
        platform_fee_bps: number;
      }
    >();
  if (error) throw error;
  if (!facilitator) return { facilitator: null, service: null };

  const { data: service, error: serviceError } = await supabase
    .from('facilitator_services')
    .select(`${SERVICE_PUBLIC_COLUMNS}, meeting_url`)
    .eq('id', serviceId)
    .eq('facilitator_id', facilitator.id)
    .eq('is_active', true)
    .maybeSingle<ServiceRow>();
  if (serviceError) throw serviceError;

  return { facilitator, service };
}

async function create(
  event: APIGatewayProxyEventV2,
  user: { email: string; sub: string; givenName?: string; familyName?: string },
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const slug = typeof body.facilitatorSlug === 'string' ? body.facilitatorSlug.trim() : '';
  const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
  const startsAtRaw = typeof body.startsAt === 'string' ? body.startsAt : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : null;

  if (!slug || !serviceId || !startsAtRaw) {
    return badRequest('facilitatorSlug, serviceId and startsAt are required');
  }

  const startsAt = new Date(startsAtRaw);
  if (Number.isNaN(startsAt.getTime())) return badRequest('startsAt must be an ISO-8601 date');

  const now = new Date();
  const supabase = await getSupabase();
  const { facilitator, service } = await loadTarget(supabase, slug, serviceId);

  if (!facilitator) return notFound('Facilitator not found');
  if (!service) return notFound('Service not found');

  // Clear lapsed holds first: the exclusion constraint cannot tell an expired
  // hold from a live one, so without this an abandoned checkout would block
  // this slot even though the availability endpoint offers it.
  await releaseExpiredHolds(supabase, facilitator.id, now);

  const slot = await verifySlot(supabase, facilitator, service, startsAt, now);
  if (!slot) return conflict('That time is no longer available');

  const fee = splitFee(service.price_centavos, facilitator.platform_fee_bps);
  const isFree = fee.priceCentavos === 0;

  const name =
    [user.givenName, user.familyName].filter(Boolean).join(' ') ||
    (typeof body.name === 'string' ? body.name.trim() : '') ||
    null;

  const { data: booking, error: insertError } = await supabase
    .from('bookings')
    .insert({
      facilitator_id: facilitator.id,
      service_id: service.id,
      service_kind: service.kind,
      client_email: user.email,
      client_cognito_sub: user.sub,
      client_name: name,
      client_notes: notes,
      starts_at: slot.startsAt,
      // The padded end, so the exclusion constraint enforces the buffer.
      ends_at: slot.blockEndsAt,
      // Free calls skip PayMongo entirely and are live immediately.
      status: isFree ? 'confirmed' : 'pending_payment',
      price_centavos: fee.priceCentavos,
      platform_fee_centavos: fee.platformFeeCentavos,
      facilitator_net_centavos: fee.facilitatorNetCentavos,
      currency: service.currency,
      // Snapshotted so editing the service later cannot redirect a session
      // that is already on someone's calendar.
      meeting_url: service.meeting_url ?? null,
      hold_expires_at: isFree ? null : holdExpiry(now),
    })
    .select('id')
    .maybeSingle<{ id: string }>();

  if (insertError) {
    // Both of these are ordinary outcomes under concurrency, not faults.
    if (insertError.code === EXCLUSION_VIOLATION) {
      return conflict('Someone just booked that time — please pick another');
    }
    if (insertError.code === UNIQUE_VIOLATION) {
      return conflict("You've already had your complimentary call with this facilitator");
    }
    throw insertError;
  }
  if (!booking) throw new Error('Booking insert returned no row');

  if (isFree) {
    await confirmBooking(booking.id);
    return ok({ bookingId: booking.id, free: true, status: 'confirmed' });
  }

  // From here the row exists and holds the slot. A failure creating the
  // PayMongo session leaves a hold that lapses on its own — no orphaned
  // payment is possible, because no payment has been started.
  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';
  const { secretKey } = await getPayMongoSecret();

  const res = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        attributes: {
          payment_method_types: PAYMENT_METHODS,
          line_items: [
            {
              name: `${service.title} with ${facilitator.display_name}`,
              amount: fee.priceCentavos,
              currency: service.currency,
              quantity: 1,
            },
          ],
          billing: { email: user.email, ...(name ? { name } : {}) },
          description: service.title,
          send_email_receipt: true,
          show_line_items: true,
          // `kind` is what the webhook branches on. Course checkout writes no
          // `kind` at all, and its absence is treated as 'product' — which is
          // what keeps existing in-flight course sessions working.
          metadata: {
            kind: 'booking',
            booking_id: booking.id,
            buyer_email: user.email,
          },
          success_url: `${origin}/booking/processing`,
          cancel_url: `${origin}/facilitators/${facilitator.slug}`,
        },
      },
    }),
  });

  const payload = (await res.json()) as {
    data?: { id: string; attributes: { checkout_url: string } };
    errors?: unknown;
  };

  if (!res.ok || !payload.data) {
    console.error('[bookings.create] PayMongo rejected session', JSON.stringify(payload.errors ?? payload));
    // Release the hold rather than leaving a slot blocked for 20 minutes over
    // a failure that had nothing to do with the client.
    await supabase.from('bookings').delete().eq('id', booking.id).eq('status', 'pending_payment');
    return serverError('bookings.create', new Error('PayMongo session creation failed'));
  }

  await supabase.from('bookings').update({ paymongo_session_id: payload.data.id }).eq('id', booking.id);

  return ok({
    bookingId: booking.id,
    free: false,
    checkoutUrl: payload.data.attributes.checkout_url,
    amountCentavos: fee.priceCentavos,
    currency: service.currency,
    serviceTitle: service.title,
    startsAt: slot.startsAt,
  });
}

/**
 * Polled by the confirmation screen while the webhook lands, mirroring
 * `orders.statusBySession`. Returns the minimum the screen needs — never the
 * fee split, which is the facilitator's business and not the client's.
 */
async function status(bookingId: string, email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select('id, status, starts_at, meeting_url, client_email, facilitators(display_name, timezone), facilitator_services(title)')
    .eq('id', bookingId)
    .maybeSingle<{
      id: string;
      status: BookingStatus;
      starts_at: string;
      meeting_url: string | null;
      client_email: string;
      facilitators: { display_name: string; timezone: string } | null;
      facilitator_services: { title: string } | null;
    }>();

  if (error) throw error;
  // Not found rather than forbidden for someone else's booking: whether a given
  // id exists is not something an arbitrary caller should be able to probe.
  if (!data || data.client_email.toLowerCase() !== email.toLowerCase()) return notFound('Booking not found');

  return ok({
    bookingId: data.id,
    status: data.status,
    startsAt: data.starts_at,
    // Withheld until the booking is actually confirmed — a pending hold has
    // not been paid for.
    meetingUrl: data.status === 'confirmed' ? data.meeting_url : null,
    facilitatorName: data.facilitators?.display_name ?? null,
    timezone: data.facilitators?.timezone ?? null,
    serviceTitle: data.facilitator_services?.title ?? null,
  });
}

async function listMine(email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select(`${BOOKING_COLUMNS}, facilitators(slug, display_name, photo_url, timezone), facilitator_services(title, duration_minutes)`)
    .eq('client_email', email.toLowerCase())
    // Holds are an implementation detail of checkout, not something to show in
    // a bookings list — an abandoned one is about to be deleted anyway.
    .neq('status', 'pending_payment')
    .order('starts_at', { ascending: false });

  if (error) throw error;
  return ok({ bookings: data ?? [] });
}

/**
 * Loads a booking and proves the caller owns it.
 *
 * Every mutating path goes through this. The email comes from the verified id
 * token, never the request, so ownership is not something a caller can assert.
 */
async function loadOwned(bookingId: string, email: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select(`${BOOKING_COLUMNS}, facilitators(${BOOKING_FACILITATOR_COLUMNS}), facilitator_services(${BOOKING_SERVICE_COLUMNS})`)
    .eq('id', bookingId)
    .maybeSingle<any>();

  if (error) throw error;
  if (!data || String(data.client_email).toLowerCase() !== email.toLowerCase()) return null;
  return { supabase, booking: data };
}

async function cancel(bookingId: string, email: string): Promise<APIGatewayProxyResultV2> {
  const loaded = await loadOwned(bookingId, email);
  if (!loaded) return notFound('Booking not found');
  const { supabase, booking } = loaded;

  if (booking.status !== 'confirmed') {
    return badRequest('Only a confirmed booking can be cancelled');
  }

  const now = new Date();
  const startsAt = new Date(booking.starts_at);
  if (startsAt <= now) return badRequest('That session has already started');

  const decision = refundForCancellation({
    priceCentavos: booking.price_centavos,
    startsAt,
    now,
    cancelledBy: 'client',
  });

  const { error } = await supabase
    .from('bookings')
    .update({
      status: 'cancelled_by_client',
      cancelled_at: now.toISOString(),
      cancelled_by: 'client',
      cancellation_reason: decision.reason,
      // Recorded, not executed — a human moves the money. See
      // refundForCancellation's note.
      refund_centavos: decision.refundCentavos,
    })
    .eq('id', bookingId)
    // Loses cleanly if the facilitator cancelled the same booking concurrently.
    .eq('status', 'confirmed');

  if (error) throw error;

  await sendBookingCancelled(
    {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: booking.facilitators.email,
      facilitatorName: booking.facilitators.display_name,
      facilitatorTimezone: booking.facilitators.timezone,
      serviceTitle: booking.facilitator_services.title,
      startsAt: booking.starts_at,
      meetingUrl: booking.meeting_url,
      isFree: booking.price_centavos === 0,
    },
    { cancelledBy: 'client', refundNote: decision.reason },
  );

  return ok({
    bookingId,
    status: 'cancelled_by_client',
    refundCentavos: decision.refundCentavos,
    refundNote: decision.reason,
  });
}

/**
 * Moves a confirmed booking to a new time.
 *
 * No re-payment: the money is already recorded against this row, and the fee
 * split does not change. The new slot is verified exactly as a fresh booking
 * would be, so the notice period, blackouts and daily cap all still apply —
 * rescheduling must not be a way around rules that block booking.
 */
async function reschedule(
  bookingId: string,
  email: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const startsAtRaw = typeof body.startsAt === 'string' ? body.startsAt : '';
  const startsAt = new Date(startsAtRaw);
  if (!startsAtRaw || Number.isNaN(startsAt.getTime())) {
    return badRequest('startsAt must be an ISO-8601 date');
  }

  const loaded = await loadOwned(bookingId, email);
  if (!loaded) return notFound('Booking not found');
  const { supabase, booking } = loaded;

  if (booking.status !== 'confirmed') return badRequest('Only a confirmed booking can be moved');

  const now = new Date();
  if (new Date(booking.starts_at) <= now) return badRequest('That session has already started');

  const facilitator = booking.facilitators as FacilitatorSchedulingRow;
  const service = booking.facilitator_services as ServiceRow;

  await releaseExpiredHolds(supabase, facilitator.id, now);

  // Excluding this booking from its own availability check: its current slot
  // is `confirmed` and would otherwise block any new time that overlaps it.
  const slot = await verifySlot(supabase, facilitator, service, startsAt, now, bookingId);
  if (!slot) return conflict('That time is not available');

  const previousStartsAt = booking.starts_at as string;

  const { error } = await supabase
    .from('bookings')
    .update({ starts_at: slot.startsAt, ends_at: slot.blockEndsAt })
    .eq('id', bookingId)
    .eq('status', 'confirmed');

  if (error) {
    // The row's own old time is excluded from the overlap check by virtue of
    // being the row being updated, so a violation here means a genuine clash
    // with a different booking taken in the interim.
    if (error.code === EXCLUSION_VIOLATION) return conflict('That time was just taken');
    throw error;
  }

  await sendBookingRescheduled(
    {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: (booking.facilitators as { email: string }).email,
      facilitatorName: (booking.facilitators as { display_name: string }).display_name,
      facilitatorTimezone: facilitator.timezone,
      serviceTitle: (booking.facilitator_services as { title: string }).title,
      startsAt: slot.startsAt,
      meetingUrl: booking.meeting_url,
      isFree: booking.price_centavos === 0,
    },
    previousStartsAt,
  );

  return ok({ bookingId, status: 'confirmed', startsAt: slot.startsAt });
}

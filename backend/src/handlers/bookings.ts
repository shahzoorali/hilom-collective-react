/**
 * Client-facing bookings.
 *
 *   POST /bookings
 *   GET  /bookings/{bookingId}/status
 *   POST /bookings/{bookingId}/cancel
 *   POST /bookings/{bookingId}/reschedule
 *   GET  /me/bookings
 *   POST /packages            — buy a block of sessions
 *   GET  /me/packages         — what is left on each
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
import { createHostedCheckout } from '../lib/paymongo-checkout.js';
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
  canReschedule,
  resolveRefundPolicy,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
  type BookingStatus,
} from '../lib/booking-domain.js';
import { confirmBooking, syncBookingMeeting } from '../lib/booking-fulfillment.js';
import { PACKAGE_COLUMNS, packageState, type PackageRow } from '../lib/packages.js';
import {
  parseIntakeQuestions,
  validateIntakeAnswers,
  IntakeError,
} from '../lib/intake.js';
import {
  listMessages,
  markThreadRead,
  postMessage,
  MessageError,
} from '../lib/booking-messages.js';
import {
  sendBookingCancelled,
  sendBookingRescheduled,
  sendRescheduleDeclined,
} from '../lib/booking-email.js';

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

  // Every branch is `await`ed deliberately, not just returned: a bare
  // `return asyncFn()` inside a try hands back a *pending* promise before it
  // has rejected, so an inner throw (a Supabase error, a failed insert)
  // surfaces after this try block has already exited and the catch below
  // never runs. The rejection then reaches Lambda uncaught — the caller sees
  // the same 500 either way, but `serverError` never logs it, so a booking
  // that failed in production leaves no `[bookings]` line to debug from.
  // See the identical note in admin-facilitators.ts, where the equivalent bug
  // was caught turning a validation error into an opaque 500.
  try {
    if (path.endsWith('/me/bookings')) return await listMine(user.email);
    if (path.endsWith('/me/packages')) return await listMyPackages(user.email);
    if (path.endsWith('/packages')) {
      if (method === 'POST') return await buyPackage(event, user);
      return badRequest(`Unsupported method ${method}`);
    }
    if (!bookingId) {
      if (method === 'POST') return await create(event, user);
      return badRequest(`Unsupported method ${method}`);
    }
    if (path.endsWith('/status')) return await status(bookingId, user.email);
    if (path.endsWith('/cancel')) return await cancel(bookingId, user.email);
    if (path.endsWith('/reschedule')) return await reschedule(bookingId, user.email, event);
    if (path.endsWith('/messages')) return await messages(bookingId, user.email, method, event);
    if (path.endsWith('/intake')) return await intake(bookingId, user.email, method, event);
    if (path.endsWith('/accept-time')) return await respondToProposal(bookingId, user.email, true);
    if (path.endsWith('/decline-time')) return await respondToProposal(bookingId, user.email, false);
    return notFound();
  } catch (err) {
    // A client mis-answering an intake form is a 400 with the question that
    // needs answering, not an opaque 500.
    if (err instanceof IntakeError) return badRequest(err.message);
    if (err instanceof MessageError) return badRequest(err.message);
    return serverError('bookings', err);
  }
}

/**
 * Accepts a browser-reported IANA zone, or nothing.
 *
 * Validated by asking Intl to use it rather than by pattern: the list of valid
 * names is the platform's, not something to reimplement, and a bad one stored
 * here would throw later inside a notification email — the one place a throw
 * is least welcome. An unusable value becomes null, which every reader already
 * handles as "we don't know where they are" and degrades to a single labelled
 * time.
 */
function parseTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-PH', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return null;
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
  'id, facilitator_id, service_id, service_kind, client_email, client_name, client_notes, starts_at, ends_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, meeting_url, paymongo_session_id, hold_expires_at, cancelled_at, cancelled_by, cancellation_reason, refund_centavos, refund_full_hours, refund_half_hours, package_id, proposed_starts_at, proposed_at, proposed_note, intake_answers, intake_completed_at, created_at';

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
  'id, title, duration_minutes, buffer_minutes, min_notice_minutes, max_advance_days, max_per_day, price_centavos, currency, kind, meeting_url, refund_full_hours, refund_half_hours, intake_questions';

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
  // Where the client is, so both parties can be shown both times (0028). Not
  // required — an old browser or a blocked API just means one time is shown.
  const clientTimezone = parseTimezone(body.timezone);

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

  // Scheduling a session against a package bought earlier (0035). Everything
  // about the money is already settled; what is being spent here is a credit.
  const packageId = typeof body.packageId === 'string' ? body.packageId.trim() : '';
  let pkg: PackageRow | null = null;
  let packageShare: { priceCentavos: number; platformFeeCentavos: number; facilitatorNetCentavos: number } | null =
    null;

  if (packageId) {
    const { data, error: packageError } = await supabase
      .from('booking_packages')
      .select(PACKAGE_COLUMNS)
      .eq('id', packageId)
      .maybeSingle<PackageRow>();
    if (packageError) throw packageError;

    // Ownership on the verified email, exactly as `loadOwned` does — a package
    // id is not a capability.
    if (!data || data.client_email.toLowerCase() !== user.email.toLowerCase()) {
      return notFound('Package not found');
    }
    // And it has to be *this* facilitator's package for *this* service, or a
    // six-session credit with a cheap facilitator would buy a session with an
    // expensive one.
    if (data.facilitator_id !== facilitator.id || data.service_id !== service.id) {
      return badRequest('That package is not for this session');
    }
    if (data.status !== 'active') return badRequest('That package is not active');

    const state = await packageState(supabase, data);
    if (state.remaining <= 0 || !state.nextShare) {
      return badRequest('You have used all the sessions in that package');
    }

    pkg = data;
    packageShare = state.nextShare;
  }

  // A package is bought once and scheduled N times, so it is never booked
  // directly — the session must arrive carrying the credit it is spending.
  // Without this, booking a package charges the whole price and delivers a
  // single session, which is what kept the kind unsellable until 0035.
  if (service.kind === 'package' && !pkg) {
    return badRequest('Buy this package first, then schedule each session from your bookings.');
  }

  // Clear lapsed holds first: the exclusion constraint cannot tell an expired
  // hold from a live one, so without this an abandoned checkout would block
  // this slot even though the availability endpoint offers it.
  await releaseExpiredHolds(supabase, facilitator.id, now);

  const slot = await verifySlot(supabase, facilitator, service, startsAt, now);
  if (!slot) return conflict('That time is no longer available');

  // A package session carries its own share of an already-collected payment —
  // see splitPackageSessions for why the shares are allocated rather than
  // divided, and 0035 for why the facilitator earns them on delivery.
  const fee = packageShare ?? splitFee(service.price_centavos, facilitator.platform_fee_bps);
  // Nothing to pay at this step either way: a package was paid for on purchase,
  // and a free call was never charged. Both are confirmed immediately.
  const isFree = fee.priceCentavos === 0 || Boolean(pkg);
  const refundPolicy = resolveRefundPolicy(
    pkg
      ? { fullHours: pkg.refund_full_hours, halfHours: pkg.refund_half_hours }
      : { fullHours: service.refund_full_hours, halfHours: service.refund_half_hours },
  );

  // Validated against the service's *current* form, and required questions are
  // enforced here rather than only in the browser — an intake a facilitator
  // relies on for screening has to be more than a client-side asterisk. The
  // answers carry a copy of the label each was answering; see 0032.
  const intakeQuestions = parseIntakeQuestions(service.intake_questions);
  const intakeAnswers = validateIntakeAnswers(intakeQuestions, body.intake);
  const intakeCompletedAt = intakeQuestions.length > 0 ? now.toISOString() : null;

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
      client_timezone: clientTimezone,
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
      // Snapshotted for the same reason as the price and the fee split: what
      // this client is owed if they cancel must not move when the facilitator
      // edits their policy next month.
      refund_full_hours: refundPolicy.fullHours,
      refund_half_hours: refundPolicy.halfHours,
      intake_answers: intakeAnswers,
      intake_completed_at: intakeCompletedAt,
      package_id: pkg?.id ?? null,
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
    return ok({
      bookingId: booking.id,
      free: true,
      status: 'confirmed',
      // Told back so the screen can say "four sessions left" without a second
      // request, and so a client who has just spent their last one knows it.
      packageRemaining: pkg ? (await packageState(supabase, pkg)).remaining : undefined,
    });
  }

  // From here the row exists and holds the slot. A failure creating the
  // PayMongo session leaves a hold that lapses on its own — no orphaned
  // payment is possible, because no payment has been started.
  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';

  let session;
  try {
    session = await createHostedCheckout({
      name: `${service.title} with ${facilitator.display_name}`,
      description: service.title,
      amountCentavos: fee.priceCentavos,
      currency: service.currency,
      billing: { email: user.email, name },
      // `kind` is what the webhook branches on. Course checkout writes no
      // `kind` at all, and its absence is treated as 'product' — which is
      // what keeps existing in-flight course sessions working.
      metadata: {
        kind: 'booking',
        booking_id: booking.id,
        buyer_email: user.email,
      },
      successUrl: `${origin}/booking/processing`,
      cancelUrl: `${origin}/facilitators/${facilitator.slug}`,
    });
  } catch (err) {
    // Release the hold rather than leaving a slot blocked for 20 minutes over
    // a failure that had nothing to do with the client.
    await supabase.from('bookings').delete().eq('id', booking.id).eq('status', 'pending_payment');
    return serverError('bookings.create', err);
  }

  await supabase.from('bookings').update({ paymongo_session_id: session.sessionId }).eq('id', booking.id);

  return ok({
    bookingId: booking.id,
    free: false,
    checkoutUrl: session.checkoutUrl,
    amountCentavos: fee.priceCentavos,
    currency: service.currency,
    serviceTitle: service.title,
    startsAt: slot.startsAt,
  });
}

/**
 * Buy a multi-session package (0035).
 *
 * Unlike `create` above, this holds no slot and books no time. A package is a
 * right to schedule; the sessions are chosen afterwards, one at a time, through
 * the same `create` path with a `packageId` instead of a payment.
 *
 * That makes this the simple half of the flow: nothing races, nothing expires,
 * and an abandoned checkout leaves a `pending_payment` row that grants no
 * credits and blocks nothing. There is no hold to reclaim because there was
 * never anything held.
 */
async function buyPackage(
  event: APIGatewayProxyEventV2,
  user: { email: string; sub: string; givenName?: string; familyName?: string },
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const slug = typeof body.facilitatorSlug === 'string' ? body.facilitatorSlug.trim() : '';
  const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
  if (!slug || !serviceId) return badRequest('facilitatorSlug and serviceId are required');

  const supabase = await getSupabase();
  const { facilitator, service } = await loadTarget(supabase, slug, serviceId);
  if (!facilitator) return notFound('Facilitator not found');
  if (!service) return notFound('Service not found');
  if (service.kind !== 'package') return badRequest('That is not a package');
  // The column allows 1 for every other kind; a one-session "package" is a
  // standard session sold under a confusing name, and would give the buyer a
  // credit flow for no reason.
  if (!service.sessions_count || service.sessions_count < 2) {
    return badRequest('That package is not set up correctly — ask the facilitator.');
  }

  const fee = splitFee(service.price_centavos, facilitator.platform_fee_bps);
  const name =
    [user.givenName, user.familyName].filter(Boolean).join(' ') ||
    (typeof body.name === 'string' ? body.name.trim() : '') ||
    null;

  const { data: pkg, error: insertError } = await supabase
    .from('booking_packages')
    .insert({
      facilitator_id: facilitator.id,
      service_id: service.id,
      client_email: user.email,
      client_cognito_sub: user.sub,
      client_name: name,
      client_timezone: parseTimezone(body.timezone),
      // Snapshotted: the credit count and the money must not move when the
      // service is edited.
      sessions_total: service.sessions_count,
      price_centavos: fee.priceCentavos,
      platform_fee_centavos: fee.platformFeeCentavos,
      facilitator_net_centavos: fee.facilitatorNetCentavos,
      currency: service.currency,
      refund_full_hours: service.refund_full_hours ?? 24,
      refund_half_hours: service.refund_half_hours ?? 12,
      // A free package would be an unlimited supply of free sessions, so the
      // service editor forbids a zero-priced package; this is the second layer.
      status: 'pending_payment',
    })
    .select('id')
    .maybeSingle<{ id: string }>();

  if (insertError) throw insertError;
  if (!pkg) throw new Error('Package insert returned no row');

  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';

  let session;
  try {
    session = await createHostedCheckout({
      name: `${service.title} with ${facilitator.display_name}`,
      description: `${service.sessions_count} sessions`,
      amountCentavos: fee.priceCentavos,
      currency: service.currency,
      billing: { email: user.email, name },
      metadata: {
        // The webhook branches on this. A new value rather than reusing
        // 'booking': a package activation creates no session, sends a different
        // email, and must not be routed into confirmBooking.
        kind: 'package',
        package_id: pkg.id,
        buyer_email: user.email,
      },
      successUrl: `${origin}/booking/processing?packageId=${encodeURIComponent(pkg.id)}`,
      cancelUrl: `${origin}/facilitators/${facilitator.slug}`,
    });
  } catch (err) {
    // Nothing was held, so this is a tidy-up rather than a release.
    await supabase
      .from('booking_packages')
      .delete()
      .eq('id', pkg.id)
      .eq('status', 'pending_payment');
    return serverError('bookings.buyPackage', err);
  }

  await supabase
    .from('booking_packages')
    .update({ paymongo_session_id: session.sessionId })
    .eq('id', pkg.id);

  return ok({
    packageId: pkg.id,
    checkoutUrl: session.checkoutUrl,
    amountCentavos: fee.priceCentavos,
    currency: service.currency,
    sessionsTotal: service.sessions_count,
    serviceTitle: service.title,
  });
}

/**
 * The client's packages, with what is left on each.
 *
 * Credits are counted rather than stored — see `packageState`. A stored counter
 * would have to be decremented on booking and incremented on cancellation, and
 * the two paths that must agree about someone's money are exactly the two paths
 * that eventually do not.
 */
async function listMyPackages(email: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('booking_packages')
    .select(`${PACKAGE_COLUMNS}, facilitators(slug, display_name, photo_url, timezone), facilitator_services(title, duration_minutes)`)
    .eq('client_email', email.toLowerCase())
    // An abandoned checkout is not a package anybody owns.
    .neq('status', 'pending_payment')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  const packages = await Promise.all(
    ((data ?? []) as any[]).map(async (pkg) => {
      const state = await packageState(supabase, pkg as PackageRow);
      return { ...pkg, remaining: state.remaining, used: state.used };
    }),
  );

  return ok({ packages });
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
    .select(`${BOOKING_COLUMNS}, facilitators(slug, display_name, photo_url, timezone), facilitator_services(title, duration_minutes, intake_questions)`)
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
    // A package session returns its credit instead of any money — see 0035.
    fromPackage: Boolean(booking.package_id),
    // The booking's own snapshot, not the service's current setting. Null on a
    // row written before 0027, which resolves to the ladder that was in force
    // when it was taken.
    policy: resolveRefundPolicy({
      fullHours: booking.refund_full_hours,
      halfHours: booking.refund_half_hours,
    }),
  });

  const { data: cancelled, error } = await supabase
    .from('bookings')
    .update({
      status: 'cancelled_by_client',
      cancelled_at: now.toISOString(),
      cancelled_by: 'client',
      cancellation_reason: decision.reason,
      // Recorded, not executed — a human moves the money. See
      // refundForCancellation's note.
      refund_centavos: decision.refundCentavos,
      // A suggested time on a cancelled session is an offer to attend
      // something that is no longer happening.
      proposed_starts_at: null,
      proposed_at: null,
      proposed_note: null,
    })
    .eq('id', bookingId)
    // Loses cleanly if the facilitator cancelled the same booking concurrently.
    .eq('status', 'confirmed')
    // Required for "loses cleanly" to actually hold: a filtered update that
    // matches nothing raises no error, so without reading back the row this
    // path would email a second cancellation and report a refund the database
    // never recorded — and the two sides disagree about money, because a
    // facilitator cancellation is a full refund where this one may be partial.
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw error;
  if (!cancelled) {
    return conflict('That booking was already cancelled.');
  }

  // Delete the provider-hosted meeting if there is one. No-op for a manual
  // link or a Google Meet space; a DELETE for a scheduled Zoom meeting. Never
  // blocks the cancellation.
  await syncBookingMeeting(supabase, bookingId, 'cancelled');

  await sendBookingCancelled(
    {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: booking.facilitators.email,
      facilitatorName: booking.facilitators.display_name,
      facilitatorTimezone: booking.facilitators.timezone,
      clientTimezone: booking.client_timezone,
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
 * The client's half of a booking's message thread (0034).
 *
 *   GET  — the conversation, and everything the facilitator wrote is marked read
 *   POST — say something
 *
 * Ownership is `loadOwned`, exactly as for cancelling or rescheduling: the
 * thread belongs to the booking, so "may I read this" is a question this
 * handler already knew how to answer. That is most of why threads are scoped to
 * a booking rather than to a pair of people — see 0034.
 */
async function messages(
  bookingId: string,
  email: string,
  method: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const loaded = await loadOwned(bookingId, email);
  if (!loaded) return notFound('Booking not found');
  const { supabase, booking } = loaded;

  if (method === 'GET') {
    const thread = await listMessages(supabase, bookingId);
    // Opening the thread is reading it. Only the facilitator's messages are
    // touched — see markThreadRead.
    await markThreadRead(supabase, bookingId, 'client');
    return ok({ messages: thread });
  }

  if (method !== 'POST') return badRequest(`Unsupported method ${method}`);

  // Nothing to talk about on a session that was cancelled or has long passed —
  // and an open channel on a dead booking is a channel with no context.
  if (booking.status !== 'confirmed' && booking.status !== 'completed' && booking.status !== 'no_show') {
    return badRequest('This session is no longer active, so the conversation is closed.');
  }

  const facilitator = booking.facilitators as { email: string; display_name: string; timezone: string };
  const message = await postMessage(supabase, {
    bookingId,
    sender: 'client',
    senderEmail: email,
    body: parseBody(event).body,
    notify: {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      clientTimezone: booking.client_timezone,
      facilitatorEmail: facilitator.email,
      facilitatorName: facilitator.display_name,
      facilitatorTimezone: facilitator.timezone,
      serviceTitle: (booking.facilitator_services as { title: string }).title,
      startsAt: booking.starts_at,
    },
  });

  return ok({ message });
}

/**
 * The client's own intake form: read it, or answer it later (0032).
 *
 *   GET  /bookings/{id}/intake  — the questions, and whatever they have said
 *   PUT  /bookings/{id}/intake  — submit or revise their answers
 *
 * Answering after the fact matters as much as answering at booking time. The
 * form is asked during checkout, when someone is mid-payment and wants to be
 * finished; a health question they half-remember is exactly the one they will
 * want to correct that evening. So the form stays open until the session
 * starts, and required questions are enforced on every submission — a revision
 * that quietly emptied a required answer would leave the facilitator believing
 * they had screened something they had not.
 *
 * It closes once the session has started. After that it is a record of what
 * was said beforehand, and editing it would be rewriting the facilitator's
 * notes on a session that already happened.
 */
async function intake(
  bookingId: string,
  email: string,
  method: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const loaded = await loadOwned(bookingId, email);
  if (!loaded) return notFound('Booking not found');
  const { supabase, booking } = loaded;

  const questions = parseIntakeQuestions(
    (booking.facilitator_services as { intake_questions?: unknown } | null)?.intake_questions,
  );

  if (method === 'GET') {
    return ok({
      questions,
      answers: booking.intake_answers ?? [],
      completedAt: booking.intake_completed_at ?? null,
      // The screen needs to know whether editing is still open, and the reason
      // is worth stating rather than leaving a form mysteriously read-only.
      editable: new Date(booking.starts_at) > new Date() && booking.status === 'confirmed',
    });
  }

  if (method !== 'PUT') return badRequest(`Unsupported method ${method}`);

  if (booking.status !== 'confirmed') {
    return badRequest('This form can only be filled in for a confirmed session');
  }
  if (new Date(booking.starts_at) <= new Date()) {
    return badRequest('That session has already started — this form is now a record of what you said before it.');
  }
  if (questions.length === 0) return badRequest('This session has no intake form');

  const body = parseBody(event);
  const answers = validateIntakeAnswers(questions, body.intake ?? body.answers);

  const { error } = await supabase
    .from('bookings')
    .update({ intake_answers: answers, intake_completed_at: new Date().toISOString() })
    .eq('id', bookingId)
    // Belt and braces with the status check above: a booking cancelled between
    // the read and this write must not accept a new submission.
    .eq('status', 'confirmed');

  if (error) throw error;
  return ok({ answers, completedAt: new Date().toISOString() });
}

/**
 * The client's answer to a time their facilitator suggested (0029).
 *
 * Accepting is what actually moves the session — the proposal changed nothing
 * until now, which is the whole design: a facilitator can ask, not act.
 *
 * The proposed slot was never held, so it is re-verified here through exactly
 * the same engine as a fresh booking. A time that has since been taken comes
 * back as a conflict rather than an error, and the proposal is cleared so the
 * client is not left staring at an offer that can no longer be accepted.
 *
 * Deliberately *not* subject to `canReschedule`. That rule protects the
 * facilitator's committed hour from a client moving it late; here the
 * facilitator is the one asking, and refusing their own request twelve hours
 * out would make the feature useless in exactly the case it exists for.
 */
async function respondToProposal(
  bookingId: string,
  email: string,
  accept: boolean,
): Promise<APIGatewayProxyResultV2> {
  const loaded = await loadOwned(bookingId, email);
  if (!loaded) return notFound('Booking not found');
  const { supabase, booking } = loaded;

  if (!booking.proposed_starts_at) return badRequest('There is no suggested time on this booking');
  if (booking.status !== 'confirmed') return badRequest('Only a confirmed booking can be moved');

  const clearProposal = { proposed_starts_at: null, proposed_at: null, proposed_note: null };
  const facilitator = booking.facilitators as FacilitatorSchedulingRow & {
    email: string;
    display_name: string;
  };
  const service = booking.facilitator_services as ServiceRow;
  const emailContext = {
    clientEmail: booking.client_email,
    clientName: booking.client_name,
    clientTimezone: booking.client_timezone,
    facilitatorEmail: facilitator.email,
    facilitatorName: facilitator.display_name,
    facilitatorTimezone: facilitator.timezone,
    serviceTitle: service.title,
    startsAt: booking.starts_at as string,
    meetingUrl: booking.meeting_url,
    isFree: booking.price_centavos === 0,
  };

  if (!accept) {
    const { error } = await supabase.from('bookings').update(clearProposal).eq('id', bookingId);
    if (error) throw error;
    // The facilitator needs to know the hour they were trying to free is still
    // theirs — that is the actionable half, not the refusal.
    await sendRescheduleDeclined(emailContext);
    return ok({ bookingId, accepted: false, startsAt: booking.starts_at });
  }

  const now = new Date();
  const startsAt = new Date(booking.proposed_starts_at as string);
  if (startsAt <= now) {
    await supabase.from('bookings').update(clearProposal).eq('id', bookingId);
    return conflict('That suggested time has already passed — ask your facilitator for another.');
  }

  await releaseExpiredHolds(supabase, facilitator.id, now);
  const slot = await verifySlot(supabase, facilitator, service, startsAt, now, bookingId);
  if (!slot) {
    // Clear it: an offer that can never be accepted is worse than none, and
    // the facilitator can simply suggest another time.
    await supabase.from('bookings').update(clearProposal).eq('id', bookingId);
    return conflict('That time is no longer free — ask your facilitator for another.');
  }

  const previousStartsAt = booking.starts_at as string;

  const { data: moved, error } = await supabase
    .from('bookings')
    .update({ starts_at: slot.startsAt, ends_at: slot.blockEndsAt, ...clearProposal })
    .eq('id', bookingId)
    .eq('status', 'confirmed')
    // Read back for the same reason as every other filtered update here: a
    // silent zero-row update would email both parties a new time for a session
    // that was cancelled in the interim.
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) return conflict('That time was just taken');
    throw error;
  }
  if (!moved) return conflict('That booking was cancelled — it can no longer be moved.');

  await syncBookingMeeting(supabase, bookingId, 'rescheduled');
  await sendBookingRescheduled({ ...emailContext, startsAt: slot.startsAt }, previousStartsAt);

  return ok({ bookingId, accepted: true, startsAt: slot.startsAt });
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

  // Checked against the time the session currently holds, before anything
  // about the proposed new one is considered. Without this, moving a session
  // is a free alternative to a cancellation that would have cost the client
  // half the price or all of it — see canReschedule's note.
  const reschedulable = canReschedule({
    startsAt: new Date(booking.starts_at),
    now,
    policy: resolveRefundPolicy({
      fullHours: booking.refund_full_hours,
      halfHours: booking.refund_half_hours,
    }),
  });
  if (!reschedulable.allowed) return badRequest(reschedulable.reason);

  const facilitator = booking.facilitators as FacilitatorSchedulingRow;
  const service = booking.facilitator_services as ServiceRow;

  await releaseExpiredHolds(supabase, facilitator.id, now);

  // Excluding this booking from its own availability check: its current slot
  // is `confirmed` and would otherwise block any new time that overlaps it.
  const slot = await verifySlot(supabase, facilitator, service, startsAt, now, bookingId);
  if (!slot) return conflict('That time is not available');

  const previousStartsAt = booking.starts_at as string;

  const { data: moved, error } = await supabase
    .from('bookings')
    // Any open proposal is dropped: the client has just chosen a time
    // themselves, which answers the question the facilitator was asking.
    .update({
      starts_at: slot.startsAt,
      ends_at: slot.blockEndsAt,
      proposed_starts_at: null,
      proposed_at: null,
      proposed_note: null,
    })
    .eq('id', bookingId)
    .eq('status', 'confirmed')
    // Same reason as the cancel path above — a filtered update matching zero
    // rows is silent, so without this a booking cancelled in the interim would
    // still report success and email both parties a new time for a session
    // that is no longer happening.
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) {
    // The row's own old time is excluded from the overlap check by virtue of
    // being the row being updated, so a violation here means a genuine clash
    // with a different booking taken in the interim.
    if (error.code === EXCLUSION_VIOLATION) return conflict('That time was just taken');
    throw error;
  }
  if (!moved) {
    return conflict('That booking was cancelled — it can no longer be moved.');
  }

  // Move the provider-hosted meeting to match. No-op for a manual link or a
  // Google Meet space; a PATCH for a scheduled Zoom meeting. Never blocks —
  // the client already has the authoritative new time from their email.
  await syncBookingMeeting(supabase, bookingId, 'rescheduled');

  await sendBookingRescheduled(
    {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: (booking.facilitators as { email: string }).email,
      facilitatorName: (booking.facilitators as { display_name: string }).display_name,
      facilitatorTimezone: facilitator.timezone,
      clientTimezone: booking.client_timezone,
      serviceTitle: (booking.facilitator_services as { title: string }).title,
      startsAt: slot.startsAt,
      meetingUrl: booking.meeting_url,
      isFree: booking.price_centavos === 0,
    },
    previousStartsAt,
  );

  return ok({ bookingId, status: 'confirmed', startsAt: slot.startsAt });
}

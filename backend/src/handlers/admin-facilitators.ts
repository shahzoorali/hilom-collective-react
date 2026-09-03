/**
 * Admin management of facilitators, bookings and payouts.
 *
 *   GET    /admin/facilitators
 *   POST   /admin/facilitators
 *   GET    /admin/facilitators/{facilitatorId}
 *   PATCH  /admin/facilitators/{facilitatorId}
 *   GET    /admin/bookings
 *   POST   /admin/bookings/{bookingId}/cancel
 *   POST   /admin/bookings/{bookingId}/refund
 *   GET    /admin/payouts
 *   POST   /admin/payouts
 *   PATCH  /admin/payouts/{payoutId}
 *
 * Authorized with `isAdminCaller`, which accepts either an `admin`-group
 * Cognito token or the legacy shared key — see the note on that function.
 *
 * Approval is the point of this file. Anyone can apply; nobody is listed until
 * a human has read the application and decided. That review step is the whole
 * difference between a curated roster of wellness practitioners and an open
 * directory of strangers, and it is also where scope-of-practice claims get
 * checked against actual credentials.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAdminCaller } from '../lib/http.js';
import { addUserToGroup, removeUserFromGroup } from '../lib/cognito.js';
import { sendFacilitatorApproved, sendBookingCancelled, sendPayoutPaid } from '../lib/booking-email.js';
import { syncBookingMeeting } from '../lib/booking-fulfillment.js';
import { refundForCancellation } from '../lib/booking-domain.js';
import { validateProfile, FacilitatorInputError } from '../lib/facilitator-input.js';
import { normalizeSlug, slugify, findAvailableFacilitatorSlug, SlugError } from '../lib/slug.js';

const ADMIN_FACILITATOR_COLUMNS =
  'id, slug, email, cognito_sub, display_name, headline, bio, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, legal_name, phone, timezone, status, platform_fee_bps, vacation_until, payout_details, admin_notes, applied_at, approved_at, created_at, updated_at, ' +
  // Intake, from the application form (0023). Read here and nowhere else —
  // none of it is in the public column grant, and none of it belongs on a
  // profile.
  'contact_method, years_experience, support_needed, program_status, website_url, ' +
  'cert_document_key, cert_document_name, referral_source, referral_source_other, ' +
  'privacy_accepted_at, privacy_policy_version';

const VALID_STATUSES = new Set(['applied', 'approved', 'published', 'suspended', 'rejected']);

/** Kept in step with `public.review_status` in 0013_payouts_reviews.sql. */
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected']);

/** Kept in step with SUPPORT_TRACKS in facilitator-input.ts. */
const SUPPORT_TRACKS = new Set(['design', 'build_launch', 'live_experiences']);

const s3 = new S3Client({});
const DOCS_BUCKET = process.env.FACILITATOR_DOCS_BUCKET ?? '';

/** Statuses that mean "this person should be able to open the dashboard". */
const DASHBOARD_STATUSES = new Set(['approved', 'published']);

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  // Every branch below is `await`ed deliberately, not just returned: a bare
  // `return asyncFn()` inside a try block hands back a *pending* promise
  // before that promise has rejected, so by the time an inner throw (a bad
  // input, a Postgres error) actually happens, this function's own try block
  // has already exited and the catch below never runs — the error instead
  // reaches Lambda as a raw, uncaught rejection, and the caller sees a bare
  // "Internal Server Error" with none of the handling below applied. Found
  // via createFacilitator's validation error doing exactly that.
  try {
    const supabase = await getSupabase();

    if (path.includes('/admin/reviews')) return await reviews(supabase, event, method);
    if (path.includes('/admin/payouts')) return await payouts(supabase, event, method);
    if (path.includes('/admin/bookings')) {
      const bookingId = event.pathParameters?.bookingId;
      if (bookingId && path.endsWith('/cancel')) {
        return await adminCancelBooking(supabase, bookingId, parseBody(event));
      }
      if (bookingId && path.endsWith('/refund')) {
        return await markRefundSent(supabase, bookingId, parseBody(event));
      }
      return await listBookings(supabase, event);
    }

    const facilitatorId = event.pathParameters?.facilitatorId;
    if (!facilitatorId) {
      if (method === 'GET') return await listFacilitators(supabase, event);
      if (method === 'POST') return await createFacilitator(supabase, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'GET' && path.endsWith('/certificate')) {
      return await getCertificateUrl(supabase, facilitatorId);
    }
    if (method === 'GET') return await getFacilitator(supabase, facilitatorId);
    if (method === 'PATCH') return await patchFacilitator(supabase, facilitatorId, parseBody(event));
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof FacilitatorInputError || err instanceof SlugError) return badRequest(err.message);
    return serverError('adminFacilitators', err);
  }
}

/**
 * Review moderation (0013 gave the statuses; this is the screen behind them).
 *
 *   GET   /admin/reviews?status=pending
 *   PATCH /admin/reviews/{reviewId}   { status }
 *
 * Everything a client writes lands as `pending` and is invisible until someone
 * reads it. That is not a quality bar on the *opinion* — a one-star review of a
 * bad session is exactly what the feature is for, and rejecting it because it
 * is unflattering would make the whole rating worthless. It is a check that
 * what is about to be published permanently, under a real practitioner's name,
 * is not abuse, not somebody's phone number, and not a clinical disclosure the
 * client will regret making public.
 *
 * Rejection is reversible: a rejected review can be approved later, and the
 * aggregate follows either way (the trigger in 0036 keys on the status, not on
 * the transition). Nothing is deleted, because a deleted review is one the
 * client can no longer see was ever considered.
 */
async function reviews(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const reviewId = event.pathParameters?.reviewId;

  if (!reviewId) {
    if (method !== 'GET') return badRequest(`Unsupported method ${method}`);

    const status = event.queryStringParameters?.status?.trim();
    if (status && !REVIEW_STATUSES.has(status)) return badRequest('Unknown review status');

    let query = supabase
      .from('facilitator_reviews')
      .select(
        'id, booking_id, facilitator_id, rating, comment, client_label, status, created_at, updated_at, ' +
          'facilitators(slug, display_name), bookings(starts_at, client_email, facilitator_services(title))',
      )
      // Oldest first: a moderation queue is worked from the front, and the
      // review someone has been waiting on for three days is the urgent one.
      .order('created_at', { ascending: true })
      .limit(200);

    // Defaults to the queue rather than to everything — that is what this
    // screen is for, and "all" is one click away.
    if (status) query = query.eq('status', status);
    else query = query.eq('status', 'pending');

    const { data, error } = await query;
    if (error) throw error;
    return ok({ reviews: data ?? [] });
  }

  if (method !== 'PATCH') return badRequest(`Unsupported method ${method}`);

  const body = parseBody(event);
  const status = typeof body.status === 'string' ? body.status : '';
  if (!REVIEW_STATUSES.has(status)) return badRequest('status must be approved or rejected');
  if (status === 'pending') return badRequest('A review cannot be sent back to the queue');

  const { data, error } = await supabase
    .from('facilitator_reviews')
    .update({ status })
    .eq('id', reviewId)
    .select('id, status')
    .maybeSingle<{ id: string; status: string }>();

  if (error) throw error;
  if (!data) return notFound('Review not found');

  // The rating totals on the facilitator row are maintained by the trigger in
  // 0036, so there is nothing to recompute here — which is the point of them
  // being a trigger rather than something every writer has to remember.
  return ok({ review: data });
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new FacilitatorInputError('Request body is not valid JSON');
  }
}

async function listFacilitators(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const status = event.queryStringParameters?.status?.trim();
  const support = event.queryStringParameters?.support?.trim();

  let query = supabase
    .from('facilitators')
    .select(ADMIN_FACILITATOR_COLUMNS)
    .order('applied_at', { ascending: false });

  if (status && VALID_STATUSES.has(status)) query = query.eq('status', status);
  // "Show me everyone who wants help with live experiences." Applications now
  // arrive tagged with which service track they are asking for, and the person
  // who reviews a Build & Launch application is not always the person who
  // reviews a retreat.
  if (support && SUPPORT_TRACKS.has(support)) query = query.contains('support_needed', [support]);

  const { data, error } = await query;
  if (error) throw error;
  return ok({ facilitators: data ?? [] });
}

/**
 * A short-lived signed URL for an applicant's credential document.
 *
 * The document lives in a private bucket with no distribution in front of it,
 * so this is the only way to read one — deliberately, because it is a personal
 * record carrying somebody's legal name. The URL is minted per request and
 * expires in five minutes rather than being stored anywhere, so a link that
 * leaks out of an admin's browser history is worth nothing by the time anyone
 * finds it.
 */
async function getCertificateUrl(
  supabase: SupabaseClient,
  facilitatorId: string,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitators')
    .select('cert_document_key, cert_document_name')
    .eq('id', facilitatorId)
    .maybeSingle<{ cert_document_key: string | null; cert_document_name: string | null }>();

  if (error) throw error;
  if (!data) return notFound('Facilitator not found');
  if (!data.cert_document_key) return notFound('No document was submitted with this application');
  if (!DOCS_BUCKET) {
    return serverError('adminFacilitators.getCertificateUrl', new Error('docs bucket not configured'));
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: data.cert_document_key }),
    { expiresIn: 300 },
  );

  return ok({ url, filename: data.cert_document_name });
}

/**
 * Enters a facilitator Hilom has already vetted outside the app (a referral,
 * someone recruited directly) — the walk-in equivalent of the self-service
 * `/facilitators/apply`.
 *
 * Always lands in `applied`, exactly where a self-submitted application
 * lands, rather than accepting a status from the caller: approving is what
 * grants the Cognito `facilitator` group, and that grant requires a real
 * Cognito user to already exist for the email, which is not guaranteed here.
 * Routing every row through the same Approve button means that check only
 * has to be correct in one place (`patchFacilitator`, below) instead of two.
 *
 * `cognito_sub` is left null, same as an application submitted before the
 * person's first sign-in — see the note on `me()` in facilitator-portal.ts
 * for how that gets linked up automatically the first time they do sign in.
 */
async function createFacilitator(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return badRequest('A valid email is required');
  }

  const profile = validateProfile(body);

  const base = slugify(profile.display_name) || 'facilitator';
  const slug = await findAvailableFacilitatorSlug(normalizeSlug(base), async (candidate) => {
    const { data } = await supabase.from('facilitators').select('id').eq('slug', candidate).maybeSingle();
    return Boolean(data);
  });

  const { data, error } = await supabase
    .from('facilitators')
    .insert({
      ...profile,
      slug,
      email,
      legal_name: typeof body.legal_name === 'string' ? body.legal_name.trim().slice(0, 160) : null,
      phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : null,
      admin_notes: typeof body.admin_notes === 'string' ? body.admin_notes.trim().slice(0, 4000) || null : null,
      status: 'applied',
    })
    .select(ADMIN_FACILITATOR_COLUMNS)
    .maybeSingle();

  // The email-lower unique index is the same one `/facilitators/apply` can
  // hit — one person, one row, regardless of which door they came through.
  if (error?.code === '23505') return json(409, { error: `A facilitator already exists for ${email}` });
  if (error) throw error;

  return ok({ facilitator: data });
}

async function getFacilitator(
  supabase: SupabaseClient,
  facilitatorId: string,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitators')
    .select(ADMIN_FACILITATOR_COLUMNS)
    .eq('id', facilitatorId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Facilitator not found');

  const [services, bookings] = await Promise.all([
    supabase.from('facilitator_services').select('*').eq('facilitator_id', facilitatorId).order('sort_order'),
    supabase
      .from('bookings')
      .select('id, starts_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, client_email')
      .eq('facilitator_id', facilitatorId)
      .order('starts_at', { ascending: false })
      .limit(50),
  ]);

  return ok({ facilitator: data, services: services.data ?? [], bookings: bookings.data ?? [] });
}

/**
 * The approval workflow, plus fee-tier and note edits.
 *
 * Cognito group membership is kept in step with status here rather than left to
 * a second manual step, because the two disagreeing is the failure that reads
 * as "the site is broken": a facilitator marked approved in the admin table who
 * cannot open their dashboard, or — worse — a suspended one who still can.
 *
 * The group change is attempted *before* the row is written. If Cognito is
 * unreachable, the status does not move, and the admin sees an error and can
 * retry; the alternative ordering leaves the database claiming an access level
 * that was never granted.
 */
async function patchFacilitator(
  supabase: SupabaseClient,
  facilitatorId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const { data: existing, error: readError } = await supabase
    .from('facilitators')
    .select('id, email, display_name, status')
    .eq('id', facilitatorId)
    .maybeSingle<{ id: string; email: string; display_name: string; status: string }>();
  if (readError) throw readError;
  if (!existing) return notFound('Facilitator not found');

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!VALID_STATUSES.has(status)) return badRequest('Invalid status');
    patch.status = status;

    const hadAccess = DASHBOARD_STATUSES.has(existing.status);
    const getsAccess = DASHBOARD_STATUSES.has(status);

    if (getsAccess && !hadAccess) {
      await addUserToGroup(existing.email, 'facilitator');
      patch.approved_at = new Date().toISOString();
    } else if (!getsAccess && hadAccess) {
      await removeUserFromGroup(existing.email, 'facilitator');
    }
  }

  if (body.platform_fee_bps !== undefined) {
    const bps = Number(body.platform_fee_bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return badRequest('platform_fee_bps must be a whole number between 0 and 10000');
    }
    // Only affects bookings made from now on — the split is snapshotted onto
    // each booking row at the time it is taken.
    patch.platform_fee_bps = bps;
  }

  if (body.admin_notes !== undefined) {
    patch.admin_notes = String(body.admin_notes ?? '').slice(0, 4000) || null;
  }

  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  const { data, error } = await supabase
    .from('facilitators')
    .update(patch)
    .eq('id', facilitatorId)
    .select(ADMIN_FACILITATOR_COLUMNS)
    .maybeSingle();
  if (error) throw error;

  // Sent only on the transition into access, not on every later edit.
  if (patch.approved_at) {
    await sendFacilitatorApproved(existing.email, existing.display_name);
  }

  return ok({ facilitator: data });
}

async function listBookings(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const status = event.queryStringParameters?.status?.trim();
  const refund = event.queryStringParameters?.refund?.trim();

  let query = supabase
    .from('bookings')
    .select('*, facilitators(slug, display_name, email), facilitator_services(title)')
    .order('starts_at', { ascending: false })
    .limit(200);

  if (status) query = query.eq('status', status);
  // The queue that costs someone real money if it is not worked: refunds the
  // policy has promised and nobody has sent yet.
  if (refund === 'due') query = query.gt('refund_centavos', 0).is('refunded_at', null);

  const { data, error } = await query;
  if (error) throw error;
  return ok({ bookings: data ?? [] });
}

/**
 * Cancels a booking on Hilom's behalf.
 *
 * The third cancellation path, alongside the client's and the facilitator's,
 * and the only one support can reach. It exists because the other two require
 * a party who may be unreachable, uncooperative or the problem itself — a
 * facilitator who has stopped responding, a session booked fraudulently.
 *
 * Always a full refund, matching `refundForCancellation`'s existing rule for a
 * cancellation the client did not choose. An admin overriding the amount is
 * deliberately not offered: the notice-period tiers exist to price the
 * client's *own* change of mind, and none of them describe this.
 */
async function adminCancelBooking(
  supabase: SupabaseClient,
  bookingId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select(
      'id, status, starts_at, price_centavos, client_email, client_name, client_timezone, meeting_url, package_id, ' +
        'facilitators(email, display_name, timezone), facilitator_services(title)',
    )
    .eq('id', bookingId)
    .maybeSingle<any>();

  if (error) throw error;
  if (!booking) return notFound('Booking not found');
  if (booking.status !== 'confirmed') {
    return badRequest(`Only a confirmed booking can be cancelled — this one is ${booking.status}.`);
  }

  const now = new Date();
  const decision = refundForCancellation({
    priceCentavos: booking.price_centavos,
    startsAt: new Date(booking.starts_at),
    now,
    cancelledBy: 'admin',
    // A package session returns its credit rather than money — the client
    // still has the sessions they bought. See 0035.
    fromPackage: Boolean(booking.package_id),
  });

  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : decision.reason;

  const { data: cancelled, error: updateError } = await supabase
    .from('bookings')
    .update({
      // Recorded as a facilitator cancellation because that is what the
      // *client* experiences and what the refund follows — the session was
      // called off by the platform side, not by them. `cancelled_by` carries
      // the real actor for anyone reading the row.
      status: 'cancelled_by_facilitator',
      cancelled_at: now.toISOString(),
      cancelled_by: 'admin',
      cancellation_reason: reason,
      refund_centavos: decision.refundCentavos,
      proposed_starts_at: null,
      proposed_at: null,
      proposed_note: null,
    })
    .eq('id', bookingId)
    // Same reasoning as every other transition here: a filtered update that
    // matches nothing raises no error, so without reading the row back this
    // would email a cancellation that never happened.
    .eq('status', 'confirmed')
    .select('id')
    .maybeSingle<{ id: string }>();

  if (updateError) throw updateError;
  if (!cancelled) return json(409, { error: 'That booking was already cancelled.' });

  // Tear down the provider-hosted meeting if there is one. Non-blocking.
  await syncBookingMeeting(supabase, bookingId, 'cancelled');

  const facilitator = booking.facilitators;
  const service = booking.facilitator_services;
  if (facilitator && service) {
    await sendBookingCancelled(
      {
        clientEmail: booking.client_email,
        clientName: booking.client_name,
        facilitatorEmail: facilitator.email,
        facilitatorName: facilitator.display_name,
        facilitatorTimezone: facilitator.timezone,
        clientTimezone: booking.client_timezone,
        serviceTitle: service.title,
        startsAt: booking.starts_at,
        meetingUrl: booking.meeting_url,
        isFree: booking.price_centavos === 0,
      },
      { cancelledBy: 'admin', refundNote: reason },
    );
  }

  return ok({
    bookingId,
    status: 'cancelled_by_facilitator',
    refundCentavos: decision.refundCentavos,
  });
}

/**
 * Records that a refund has actually been sent.
 *
 * The money moves by hand, outside this system, exactly as payouts and course
 * refunds do. This is the ledger entry proving it happened — without it,
 * `refund_centavos` says only what was promised, and "has this client been
 * refunded?" can only be answered from the PayMongo dashboard.
 *
 * A reference is required rather than optional for the same reason the payout
 * flow demands one: an unverifiable claim that money moved is worth very
 * little when somebody disputes it later.
 */
async function markRefundSent(
  supabase: SupabaseClient,
  bookingId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 200) : '';
  if (!reference) return badRequest('A payment or bank reference is required');

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, refund_centavos, refunded_at')
    .eq('id', bookingId)
    .maybeSingle<{ id: string; refund_centavos: number | null; refunded_at: string | null }>();

  if (error) throw error;
  if (!booking) return notFound('Booking not found');
  if (!booking.refund_centavos || booking.refund_centavos <= 0) {
    return badRequest('No refund is owed on this booking');
  }
  if (booking.refunded_at) {
    return json(409, { error: 'This refund is already recorded as sent.' });
  }

  const { data: marked, error: updateError } = await supabase
    .from('bookings')
    .update({ refunded_at: new Date().toISOString(), refund_reference: reference })
    .eq('id', bookingId)
    // Re-asserted so two admins working the queue at once cannot both record
    // the same refund as sent, which would read as two payments.
    .is('refunded_at', null)
    .select('id, refunded_at, refund_reference')
    .maybeSingle<{ id: string; refunded_at: string; refund_reference: string }>();

  if (updateError) throw updateError;
  if (!marked) return json(409, { error: 'This refund is already recorded as sent.' });

  return ok({ bookingId, refundedAt: marked.refunded_at, reference: marked.refund_reference });
}

const PAYOUT_COLUMNS =
  'id, facilitator_id, period_start, period_end, gross_centavos, platform_fee_centavos, processing_fee_centavos, net_centavos, currency, status, paid_at, reference, notes, created_at';

async function payouts(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const payoutId = event.pathParameters?.payoutId;

  if (!payoutId) {
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('facilitator_payouts')
        .select(`${PAYOUT_COLUMNS}, facilitators(slug, display_name, email, payout_details)`)
        .order('period_end', { ascending: false });
      if (error) throw error;
      return ok({ payouts: data ?? [] });
    }
    if (method === 'POST') return buildPayout(supabase, parseBody(event));
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PATCH') return updatePayout(supabase, payoutId, parseBody(event));
  return badRequest(`Unsupported method ${method}`);
}

/**
 * Builds a payout batch from every unpaid, delivered booking in a period.
 *
 * "Delivered" is `completed` or `no_show` — a no-show still earns, because the
 * facilitator held the time. `confirmed` is excluded: a session in the future
 * has not been delivered and must not be paid for in advance.
 *
 * The batch is created first and the bookings are stamped with its id second.
 * PostgREST cannot wrap the two in a transaction, so the ordering is chosen for
 * the failure mode: a batch with no bookings attached is visibly wrong and
 * trivially voided, whereas bookings stamped with a payout that does not exist
 * would silently vanish from every future batch — money quietly never paid.
 */
async function buildPayout(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const facilitatorId = typeof body.facilitator_id === 'string' ? body.facilitator_id : '';
  if (!facilitatorId) return badRequest('facilitator_id is required');

  const periodStart = new Date(String(body.period_start ?? ''));
  const periodEnd = new Date(String(body.period_end ?? ''));
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return badRequest('period_start and period_end must be ISO-8601 dates');
  }
  if (periodEnd <= periodStart) return badRequest('period_end must be after period_start');

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency')
    .eq('facilitator_id', facilitatorId)
    .in('status', ['completed', 'no_show'])
    .is('payout_id', null)
    .gte('ends_at', periodStart.toISOString())
    .lt('ends_at', periodEnd.toISOString());

  if (error) throw error;
  if (!bookings || bookings.length === 0) {
    return badRequest('No unpaid sessions in that period');
  }

  const totals = bookings.reduce(
    (acc, row) => ({
      gross: acc.gross + Number(row.price_centavos ?? 0),
      fees: acc.fees + Number(row.platform_fee_centavos ?? 0),
      net: acc.net + Number(row.facilitator_net_centavos ?? 0),
    }),
    { gross: 0, fees: 0, net: 0 },
  );

  const processingFee = Number(body.processing_fee_centavos ?? 0);

  const { data: payout, error: insertError } = await supabase
    .from('facilitator_payouts')
    .insert({
      facilitator_id: facilitatorId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      gross_centavos: totals.gross,
      platform_fee_centavos: totals.fees,
      processing_fee_centavos: processingFee,
      net_centavos: totals.net - processingFee,
      currency: (bookings[0]?.currency as string) ?? 'PHP',
      status: 'draft',
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null,
    })
    .select(PAYOUT_COLUMNS)
    .maybeSingle<{ id: string }>();

  if (insertError) throw insertError;
  if (!payout) throw new Error('Payout insert returned no row');

  const { data: claimed, error: stampError } = await supabase
    .from('bookings')
    .update({ payout_id: payout.id })
    .in('id', bookings.map((b) => b.id as string))
    // Re-assert the unpaid condition: if a concurrent batch claimed some of
    // these between the read and this write, they stay with that batch rather
    // than being counted twice.
    .is('payout_id', null)
    // Read back what this batch actually won. The filter above prevents
    // double-*claiming*, but the totals were computed from the pre-stamp read,
    // so without this the row keeps paying for sessions another batch took —
    // and that other batch pays for them too. Same session, paid twice.
    .select('id, price_centavos, platform_fee_centavos, facilitator_net_centavos');

  if (stampError) throw stampError;

  const claimedRows = claimed ?? [];

  // Lost every row to a concurrent batch. Void rather than leave an empty
  // draft that reads as a real, approvable payout.
  if (claimedRows.length === 0) {
    await supabase.from('facilitator_payouts').update({ status: 'void' }).eq('id', payout.id);
    return json(409, {
      error: 'Those sessions were claimed by another payout batch. Nothing left to pay in this period.',
    });
  }

  // Re-total from what was actually claimed. Usually identical to the
  // provisional figures above; different only when a concurrent batch took
  // some, which is exactly the case this exists to get right.
  if (claimedRows.length !== bookings.length) {
    const actual = claimedRows.reduce(
      (acc, row) => ({
        gross: acc.gross + Number(row.price_centavos ?? 0),
        fees: acc.fees + Number(row.platform_fee_centavos ?? 0),
        net: acc.net + Number(row.facilitator_net_centavos ?? 0),
      }),
      { gross: 0, fees: 0, net: 0 },
    );

    const { data: corrected, error: correctionError } = await supabase
      .from('facilitator_payouts')
      .update({
        gross_centavos: actual.gross,
        platform_fee_centavos: actual.fees,
        net_centavos: actual.net - processingFee,
      })
      .eq('id', payout.id)
      .select(PAYOUT_COLUMNS)
      .maybeSingle();
    if (correctionError) throw correctionError;

    console.warn('[adminFacilitators.buildPayout] concurrent batch claimed some sessions', {
      payoutId: payout.id,
      expected: bookings.length,
      claimed: claimedRows.length,
    });

    return ok({ payout: corrected ?? payout, sessionCount: claimedRows.length });
  }

  return ok({ payout, sessionCount: claimedRows.length });
}

async function updatePayout(
  supabase: SupabaseClient,
  payoutId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!['draft', 'approved', 'paid', 'void'].includes(status)) return badRequest('Invalid payout status');
    patch.status = status;
    if (status === 'paid') patch.paid_at = new Date().toISOString();
  }
  if (body.reference !== undefined) patch.reference = String(body.reference ?? '').slice(0, 200) || null;
  if (body.notes !== undefined) patch.notes = String(body.notes ?? '').slice(0, 2000) || null;
  if (body.processing_fee_centavos !== undefined) {
    const fee = Number(body.processing_fee_centavos);
    if (!Number.isInteger(fee) || fee < 0) return badRequest('processing_fee_centavos must be a whole number');
    patch.processing_fee_centavos = fee;
  }

  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  // Read the pre-update status and the facilitator's contact once, so the
  // "you've been paid" email fires only on the actual transition into `paid`
  // — not every time an already-paid batch is re-saved (a reference edit, a
  // note) — and has an address to send to.
  const { data: before, error: beforeError } = await supabase
    .from('facilitator_payouts')
    .select('status, facilitators(email, display_name)')
    .eq('id', payoutId)
    .maybeSingle<{ status: string; facilitators: { email: string; display_name: string } | null }>();
  if (beforeError) throw beforeError;
  if (!before) return notFound('Payout not found');

  const { data, error } = await supabase
    .from('facilitator_payouts')
    .update(patch)
    .eq('id', payoutId)
    .select(PAYOUT_COLUMNS)
    .maybeSingle<{
      period_start: string;
      period_end: string;
      gross_centavos: number;
      platform_fee_centavos: number;
      processing_fee_centavos: number;
      net_centavos: number;
      currency: string;
      reference: string | null;
    }>();
  if (error) throw error;
  if (!data) return notFound('Payout not found');

  // Voiding releases the sessions back into the unpaid pool, so a mistaken
  // batch can be rebuilt rather than leaving that money unpayable.
  if (patch.status === 'void') {
    const { error: releaseError } = await supabase
      .from('bookings')
      .update({ payout_id: null })
      .eq('payout_id', payoutId);
    if (releaseError) throw releaseError;
  }

  if (patch.status === 'paid' && before.status !== 'paid' && before.facilitators) {
    // Best-effort, like every other notification here: the money has moved and
    // the row records it, so a failed send is recoverable in a way that
    // holding up the admin's "mark paid" action is not.
    await sendPayoutPaid({
      facilitatorEmail: before.facilitators.email,
      facilitatorName: before.facilitators.display_name,
      periodStart: data.period_start,
      periodEnd: data.period_end,
      grossCentavos: data.gross_centavos,
      platformFeeCentavos: data.platform_fee_centavos,
      processingFeeCentavos: data.processing_fee_centavos,
      netCentavos: data.net_centavos,
      currency: data.currency,
      reference: data.reference,
    }).catch((err: unknown) => {
      console.error('[adminFacilitators.updatePayout] payout-paid email failed', { payoutId, err });
    });
  }

  return ok({ payout: data });
}

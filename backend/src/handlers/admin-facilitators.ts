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
 *   GET    /admin/class-registrations              (?owed=true for the refund queue)
 *   POST   /admin/class-registrations/{id}/refund
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
import {
  sumPayable,
  sumClawback,
  reconcileClaim,
  payoutCurrency,
  canVoidPayout,
  PAYOUT_CLAIM_TABLES,
  PAYOUT_PRICE_COLUMN,
  PAYOUT_CLAWBACK_COLUMN,
  type PayableRow,
} from '../lib/payout-domain.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAdminCaller } from '../lib/http.js';
import { addUserToGroup, removeUserFromGroup } from '../lib/cognito.js';
import { sendFacilitatorApproved, sendFacilitatorPublished, sendBookingCancelled, sendPayoutPaid } from '../lib/booking-email.js';
import { syncBookingMeeting } from '../lib/booking-fulfillment.js';
import { refundForCancellation } from '../lib/booking-domain.js';
// The dashboard counts these same queues. Shared so a count and the screen it
// links to cannot drift — see lib/admin-queues.ts.
import { refundOwed, reviewsAwaitingModeration } from '../lib/admin-queues.js';
import { validateProfile, FacilitatorInputError } from '../lib/facilitator-input.js';
import { adminActorFromEvent, recordAudit, type AuditActor } from '../lib/audit.js';
import {
  normalizeSlug,
  slugify,
  findAvailableFacilitatorSlug,
  FACILITATOR_RESERVED_SLUGS,
  SlugError,
} from '../lib/slug.js';

const ADMIN_FACILITATOR_COLUMNS =
  'id, slug, email, cognito_sub, display_name, short_name, headline, bio, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, legal_name, phone, timezone, status, platform_fee_bps, default_event_platform_fee_bps, vacation_until, payout_details, admin_notes, applied_at, approved_at, created_at, updated_at, ' +
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
    // Built once per request. Every write below records who made it, and a
    // signed-in admin is recorded as a verified identity rather than as a
    // typed-in name — see adminActorFromEvent.
    const actor = await adminActorFromEvent(event);

    if (path.includes('/admin/reviews')) return await reviews(supabase, event, method);
    if (path.includes('/admin/payouts')) return await payouts(supabase, event, method, actor);
    if (path.includes('/admin/class-registrations')) {
      return await classRegistrations(supabase, event, method, path, actor);
    }
    if (path.includes('/admin/bookings')) {
      const bookingId = event.pathParameters?.bookingId;
      if (bookingId && path.endsWith('/cancel')) {
        return await adminCancelBooking(supabase, bookingId, parseBody(event), actor);
      }
      if (bookingId && path.endsWith('/refund')) {
        return await markRefundSent(supabase, bookingId, parseBody(event), actor);
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
    if (method === 'PATCH') return await patchFacilitator(supabase, facilitatorId, parseBody(event), actor);
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
        'id, booking_id, event_registration_id, class_registration_id, ' +
          'facilitator_id, rating, comment, client_label, status, created_at, updated_at, ' +
          'facilitators(slug, display_name), ' +
          'bookings(starts_at, client_email, facilitator_services(title)), ' +
          // 0050. An admin reading "the room was freezing" needs to know
          // whether that is about a venue or a Zoom call before deciding
          // whether it is fair — so the subject comes back with the review
          // rather than being a second request per row.
          'event_registrations(registrant_name, events(title, starts_at)), ' +
          'class_registrations(client_name, facilitator_class_sessions(starts_at, ' +
          'facilitator_classes(title)))',
      )
      // Oldest first: a moderation queue is worked from the front, and the
      // review someone has been waiting on for three days is the urgent one.
      .order('created_at', { ascending: true })
      .limit(200);

    // Defaults to the queue rather than to everything — that is what this
    // screen is for, and "all" is one click away.
    if (status) query = query.eq('status', status);
    else query = reviewsAwaitingModeration(query);

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
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const { data: existing, error: readError } = await supabase
    .from('facilitators')
    .select('id, email, display_name, status, slug')
    .eq('id', facilitatorId)
    .maybeSingle<{ id: string; email: string; display_name: string; status: string; slug: string }>();
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

  if (body.default_event_platform_fee_bps !== undefined) {
    const raw = body.default_event_platform_fee_bps;
    if (raw === null || raw === '') {
      patch.default_event_platform_fee_bps = null;
    } else {
      const bps = Number(raw);
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        return badRequest('default_event_platform_fee_bps must be a whole number between 0 and 10000, or blank');
      }
      patch.default_event_platform_fee_bps = bps;
    }
  }

  if (body.admin_notes !== undefined) {
    patch.admin_notes = String(body.admin_notes ?? '').slice(0, 4000) || null;
  }

  // `short_name` (0042) on its own is the "actually, call me X" fix an admin
  // often needs to make right after adding someone, and it stays a one-field
  // patch so the existing inline prompt keeps working. Blank clears it and the
  // heuristic in names.ts takes over again.
  if (body.short_name !== undefined && body.display_name === undefined) {
    const trimmed = String(body.short_name ?? '').trim().slice(0, 60);
    patch.short_name = trimmed || null;
  }

  // The full profile edit, from Admin -> Facilitators -> Edit profile.
  //
  // Keyed off `display_name` because `validateProfile` is a whole-profile
  // validator: it requires a name and returns every public column, so sending
  // it a partial body would blank the fields that were left out. The admin
  // editor always posts the complete profile, so the presence of the one
  // required field is what distinguishes it from the small single-field
  // patches above.
  //
  // Deliberately the same validator the facilitator's own dashboard save goes
  // through (facilitator-portal.ts) — an admin editing on someone's behalf
  // must not be able to store a bio, photo URL or social link that the owner
  // could not have stored themselves.
  if (body.display_name !== undefined) {
    Object.assign(patch, validateProfile(body));

    // Private columns, which `validateProfile` does not cover because the
    // public apply form never collects them.
    if (body.legal_name !== undefined) {
      patch.legal_name = String(body.legal_name ?? '').trim().slice(0, 160) || null;
    }
    if (body.phone !== undefined) {
      patch.phone = String(body.phone ?? '').trim().slice(0, 40) || null;
    }
    if (body.payout_details !== undefined) {
      const details = body.payout_details;
      patch.payout_details =
        details && typeof details === 'object' && !Array.isArray(details) ? details : {};
    }

    // The profile URL. Admin-only on purpose: changing it breaks every link
    // anyone has to the profile, which is not a self-service operation — the
    // same reasoning that keeps it read-only on the facilitator's own screen.
    if (body.slug !== undefined) {
      try {
        const slug = normalizeSlug(body.slug);
        if (FACILITATOR_RESERVED_SLUGS.has(slug)) {
          return badRequest(`"${slug}" is reserved — pick another profile URL`);
        }
        if (slug !== existing.slug) {
          const { data: clash } = await supabase
            .from('facilitators')
            .select('id')
            .eq('slug', slug)
            .neq('id', facilitatorId)
            .maybeSingle();
          if (clash) return badRequest(`Another facilitator already uses /facilitators/${slug}`);
          patch.slug = slug;
        }
      } catch (err) {
        if (err instanceof SlugError) return badRequest(err.message);
        throw err;
      }
    }
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

  // Sent only on the transition into `published` — the moment the profile
  // actually goes live in the directory — not on `applied → published` (which
  // is covered by the approval email above) nor on any later edit.
  if (patch.status === 'published' && existing.status !== 'published') {
    await sendFacilitatorPublished(existing.email, existing.display_name, existing.slug);
  }

  // Status only: that is the decision (approve, reject, suspend, publish) the
  // log exists to answer "who did this?" about. Profile copy edits are not.
  if (patch.status !== undefined && patch.status !== existing.status) {
    await recordAudit(actor, {
      action: 'facilitator.status_changed',
      targetTable: 'facilitators',
      targetId: facilitatorId,
      before: { status: existing.status },
      after: { status: patch.status },
      note: `${existing.display_name}: ${existing.status} → ${String(patch.status)}`,
    });
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
  if (refund === 'due') query = refundOwed(query);

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
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select(
      'id, status, starts_at, ends_at, price_centavos, client_email, client_name, client_timezone, meeting_url, package_id, ' +
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
        endsAt: booking.ends_at,
        bookingId,
        meetingUrl: booking.meeting_url,
        isFree: booking.price_centavos === 0,
      },
      { cancelledBy: 'admin', refundNote: reason },
    );
  }

  await recordAudit(actor, {
    action: 'booking.cancel',
    targetTable: 'bookings',
    targetId: bookingId,
    // The refund this cancellation promised — what the queue now owes.
    amountCentavos: decision.refundCentavos,
    currency: 'PHP',
    before: { status: 'confirmed' },
    after: { status: 'cancelled_by_facilitator', refund_centavos: decision.refundCentavos },
    note: `${booking.client_email}: ${reason}`,
  });

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
  actor: AuditActor,
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

  await recordAudit(actor, {
    action: 'booking.refund_sent',
    targetTable: 'bookings',
    targetId: bookingId,
    amountCentavos: booking.refund_centavos,
    currency: 'PHP',
    after: { refunded_at: marked.refunded_at },
    note: `reference ${marked.refund_reference}`,
  });

  return ok({ bookingId, refundedAt: marked.refunded_at, reference: marked.refund_reference });
}

const PAYOUT_COLUMNS =
  'id, facilitator_id, period_start, period_end, gross_centavos, platform_fee_centavos, processing_fee_centavos, ' +
  // 0059. Zero on every batch that reclaimed nothing, which is most of them.
  'clawback_centavos, net_centavos, currency, status, paid_at, reference, notes, created_at';

async function payouts(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  method: string,
  actor: AuditActor,
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
    if (method === 'POST') return buildPayout(supabase, parseBody(event), actor);
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PATCH') return updatePayout(supabase, payoutId, parseBody(event), actor);
  return badRequest(`Unsupported method ${method}`);
}

/**
 * Builds a payout batch from every unpaid, delivered piece of work in a period.
 *
 * Two sources since 0051: 1:1 bookings and group class seats. They are totalled
 * together into one batch because a facilitator is one person owed one sum —
 * splitting the payout by product would make them reconcile two transfers
 * against one month's work.
 *
 * "Delivered" is `completed` or `no_show` for a booking — a no-show still
 * earns, because the facilitator held the time. `confirmed` is excluded: a
 * session in the future has not been delivered and must not be paid for in
 * advance. For a class seat it is `completed`, which the booking sweep sets
 * once the session has ended; a `cancelled` seat earns nothing, which is the
 * whole point of cancelling it.
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
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const facilitatorId = typeof body.facilitator_id === 'string' ? body.facilitator_id : '';
  if (!facilitatorId) return badRequest('facilitator_id is required');

  const periodStart = new Date(String(body.period_start ?? ''));
  const periodEnd = new Date(String(body.period_end ?? ''));
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return badRequest('period_start and period_end must be ISO-8601 dates');
  }
  if (periodEnd <= periodStart) return badRequest('period_end must be after period_start');

  const [bookingRes, classRes, eventRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency')
      .eq('facilitator_id', facilitatorId)
      .in('status', ['completed', 'no_show'])
      .is('payout_id', null)
      .gte('ends_at', periodStart.toISOString())
      .lt('ends_at', periodEnd.toISOString()),
    // Group class seats (0051). The period is filtered on the *session's*
    // end, not the registration's — when the class happened is what decides
    // which month it is paid in, and a seat sold in March for an April class
    // is April's work. `!inner` is what makes that filter reach the embedded
    // row at all; without it every registration comes back regardless of date.
    supabase
      .from('class_registrations')
      .select(
        'id, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, ' +
          'facilitator_class_sessions!inner(ends_at)',
      )
      .eq('facilitator_id', facilitatorId)
      .eq('status', 'completed')
      .is('payout_id', null)
      .gte('facilitator_class_sessions.ends_at', periodStart.toISOString())
      .lt('facilitator_class_sessions.ends_at', periodEnd.toISOString())
      // The embedded relation defeats PostgREST's inferred row type, exactly
      // as it does on every other joined read in this codebase.
      .returns<PayableRow[]>(),
    // Event ticket sales (0054). The row is the *charge*, not the
    // registration: an instalment plan pays in parts weeks apart, and a
    // facilitator has earned the parts that actually cleared.
    //
    // `facilitator_net_centavos is not null` is the load-bearing filter. A
    // null split means the event has no revenue share at all — Hilom's own
    // programme, and every event that existed before 0054 — as distinct from
    // one that earned zero. Dropping this filter would retroactively owe
    // facilitators for events Hilom ran itself.
    //
    // The period is filtered on the event's `delivered_at` (its end, or its
    // start when it has no end) for the same reason a class is filtered on
    // its session's end: when the work happened decides which month pays for
    // it, not when the ticket was sold. `!inner` is what lets the filter reach
    // the embedded row at all.
    supabase
      .from('registration_charges')
      .select(
        'id, price_centavos:amount_centavos, platform_fee_centavos, facilitator_net_centavos, ' +
          'currency, events!inner(facilitator_id, delivered_at), event_registrations!inner(status, refunded_at)',
      )
      .eq('status', 'paid')
      .is('payout_id', null)
      .not('facilitator_net_centavos', 'is', null)
      // A seat that was cancelled earns nothing, however it was paid for. The
      // refund flag lives on the *registration*, not the charge — a paid
      // charge never changes status when its registration is later refunded
      // (see the note on cancelEventDate: paid charges are left exactly as
      // they are). Most refunds also cancel the registration, which the
      // status check alone would catch, but a partial refund from
      // priceOverride() can leave it `confirmed` with money owed back.
      .eq('event_registrations.status', 'confirmed')
      .is('event_registrations.refunded_at', null)
      .eq('events.facilitator_id', facilitatorId)
      .gte('events.delivered_at', periodStart.toISOString())
      .lt('events.delivered_at', periodEnd.toISOString())
      .returns<PayableRow[]>(),
  ]);

  const error = bookingRes.error ?? classRes.error ?? eventRes.error;
  if (error) throw error;

  const bookings = bookingRes.data ?? [];
  const classSeats = classRes.data ?? [];
  const eventCharges = eventRes.data ?? [];

  // Clawbacks (0059): work an earlier, already-*paid* batch paid for, that has
  // since been refunded. Not period-filtered like the three sources above —
  // a clawback has no period of its own to wait for, and surfaces in whichever
  // batch this facilitator's next one happens to be.
  const [bookingClawbackRes, classClawbackRes, chargeClawbackRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency')
      .eq('facilitator_id', facilitatorId)
      .not('payout_id', 'is', null)
      .gt('refund_centavos', 0)
      .not('refunded_at', 'is', null)
      .is(PAYOUT_CLAWBACK_COLUMN, null),
    supabase
      .from('class_registrations')
      .select('id, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency')
      .eq('facilitator_id', facilitatorId)
      .not('payout_id', 'is', null)
      .gt('refund_centavos', 0)
      .not('refunded_at', 'is', null)
      .is(PAYOUT_CLAWBACK_COLUMN, null),
    // The refund flag is on the registration, not the charge (see the note
    // above on why the earnings read checks it the same way).
    supabase
      .from('registration_charges')
      .select(
        'id, price_centavos:amount_centavos, platform_fee_centavos, facilitator_net_centavos, ' +
          'currency, events!inner(facilitator_id), event_registrations!inner(refunded_at)',
      )
      .not('payout_id', 'is', null)
      .not('facilitator_net_centavos', 'is', null)
      .eq('events.facilitator_id', facilitatorId)
      .not('event_registrations.refunded_at', 'is', null)
      .is(PAYOUT_CLAWBACK_COLUMN, null)
      .returns<PayableRow[]>(),
  ]);
  const clawbackError = bookingClawbackRes.error ?? classClawbackRes.error ?? chargeClawbackRes.error;
  if (clawbackError) throw clawbackError;

  const clawbackBookings = bookingClawbackRes.data ?? [];
  const clawbackClasses = classClawbackRes.data ?? [];
  const clawbackCharges = chargeClawbackRes.data ?? [];
  const clawbackRows = [...clawbackBookings, ...clawbackClasses, ...clawbackCharges];

  if (
    bookings.length === 0 &&
    classSeats.length === 0 &&
    eventCharges.length === 0 &&
    clawbackRows.length === 0
  ) {
    return badRequest('No unpaid sessions, classes or event tickets in that period, and nothing to claw back');
  }

  // One reducer over all three sources — the column names are identical by
  // design (0051, and aliased for charges in 0054). Lives in payout-domain.ts,
  // with the tests that make the reconciliation below trustworthy.
  const totals = sumPayable([...bookings, ...classSeats, ...eventCharges]);
  const clawbackTotal = sumClawback(clawbackRows);

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
      clawback_centavos: clawbackTotal,
      net_centavos: totals.net - processingFee - clawbackTotal,
      currency: payoutCurrency(bookings, classSeats, eventCharges, clawbackRows),
      status: 'draft',
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null,
    })
    .select(PAYOUT_COLUMNS)
    .maybeSingle<{ id: string }>();

  if (insertError) throw insertError;
  if (!payout) throw new Error('Payout insert returned no row');

  // Every source is stamped the same way and for the same reasons. The
  // `.is('payout_id', null)` re-assertion prevents a concurrent batch's rows
  // being claimed twice; reading back what was actually won is what stops this
  // batch *paying* for work another batch took — the filter prevents the
  // double claim, not the double payment.
  //
  // The table type is PAYOUT_CLAIM_TABLES, the same list updatePayout releases
  // on void, so a new source cannot be stamped here without being released
  // there too.
  const stamp = async (
    table: (typeof PAYOUT_CLAIM_TABLES)[number],
    column: 'payout_id' | typeof PAYOUT_CLAWBACK_COLUMN,
    ids: string[],
  ) => {
    if (ids.length === 0) return [];
    const { data, error: stampError } = await supabase
      .from(table)
      .update({ [column]: payout.id })
      .in('id', ids)
      .is(column, null)
      .select(
        `id, price_centavos:${PAYOUT_PRICE_COLUMN[table]}, platform_fee_centavos, facilitator_net_centavos`,
      )
      .returns<PayableRow[]>();
    if (stampError) throw stampError;
    return data ?? [];
  };

  // Sequential, not Promise.all: if stamping the classes throws, the bookings
  // are already stamped to a batch that exists and is visible, which is
  // recoverable by voiding it. Running both at once and failing one leaves the
  // same state with no ordering to reason about.
  const claimedBookings = await stamp('bookings', 'payout_id', bookings.map((b) => b.id as string));
  const claimedClasses = await stamp('class_registrations', 'payout_id', classSeats.map((c) => c.id as string));
  const claimedCharges = await stamp('registration_charges', 'payout_id', eventCharges.map((c) => c.id as string));
  const claimedRows = [...claimedBookings, ...claimedClasses, ...claimedCharges];

  const claimedClawbackBookings = await stamp(
    'bookings',
    PAYOUT_CLAWBACK_COLUMN,
    clawbackBookings.map((b) => b.id as string),
  );
  const claimedClawbackClasses = await stamp(
    'class_registrations',
    PAYOUT_CLAWBACK_COLUMN,
    clawbackClasses.map((c) => c.id as string),
  );
  const claimedClawbackCharges = await stamp(
    'registration_charges',
    PAYOUT_CLAWBACK_COLUMN,
    clawbackCharges.map((c) => c.id as string),
  );
  const claimedClawbackRows = [...claimedClawbackBookings, ...claimedClawbackClasses, ...claimedClawbackCharges];
  const actualClawback = sumClawback(claimedClawbackRows);

  // What this batch actually won, decided by the tested reconciliation in
  // payout-domain.ts rather than inline here. `claimedRows` is deliberately
  // the read-back from the stamping update, not the initial read: passing the
  // latter would make the whole reconciliation a no-op and restore the
  // double-payment it exists to prevent.
  const reconciled = reconcileClaim({
    expected: [...bookings, ...classSeats, ...eventCharges],
    claimed: claimedRows,
    processingFeeCentavos: processingFee,
  });

  // Lost every row to a concurrent batch, *and* nothing to claw back either —
  // void rather than leave an empty draft that reads as a real, approvable
  // payout. A batch that only claws back is not empty; it still owes Hilom
  // that write, so it is left standing even with zero new earnings.
  if (reconciled.outcome === 'empty' && claimedClawbackRows.length === 0) {
    await supabase.from('facilitator_payouts').update({ status: 'void' }).eq('id', payout.id);
    return json(409, {
      error: 'That work was claimed by another payout batch. Nothing left to pay or claw back in this period.',
    });
  }

  // Re-total from what was actually claimed on both sides. Identical to the
  // provisional figures above unless a concurrent batch took some — of either
  // the earnings or the clawbacks — which is exactly the case this exists to
  // get right. Written unconditionally rather than only on a partial earnings
  // claim, because the clawback side can drift independently of it.
  const finalTotals = reconciled.outcome === 'empty' ? { gross: 0, fees: 0 } : reconciled.totals;
  const finalNet =
    (reconciled.outcome === 'empty' ? 0 : reconciled.netAfterProcessing) - actualClawback;

  const { data: corrected, error: correctionError } = await supabase
    .from('facilitator_payouts')
    .update({
      gross_centavos: finalTotals.gross,
      platform_fee_centavos: finalTotals.fees,
      clawback_centavos: actualClawback,
      net_centavos: finalNet,
    })
    .eq('id', payout.id)
    .select(PAYOUT_COLUMNS)
    .maybeSingle();
  if (correctionError) throw correctionError;

  if (reconciled.outcome === 'partial' || actualClawback !== clawbackTotal) {
    console.warn('[adminFacilitators.buildPayout] concurrent batch claimed some work', {
      payoutId: payout.id,
      expected: bookings.length + classSeats.length + eventCharges.length,
      claimed: claimedRows.length,
      expectedClawback: clawbackRows.length,
      claimedClawback: claimedClawbackRows.length,
    });
  }

  await auditPayoutBuilt(actor, corrected ?? payout, claimedRows.length);
  return ok({
    payout: corrected ?? payout,
    sessionCount: claimedRows.length,
    bookingCount: claimedBookings.length,
    classCount: claimedClasses.length,
    eventCount: claimedCharges.length,
    clawbackCount: claimedClawbackRows.length,
    clawbackCentavos: actualClawback,
  });
}

/** One audit row for a newly built payout batch, whichever return path built it. */
async function auditPayoutBuilt(actor: AuditActor, payout: unknown, sessionCount: number): Promise<void> {
  const row = (payout ?? {}) as {
    id?: string;
    facilitator_id?: string;
    net_centavos?: number;
    currency?: string;
    period_start?: string;
    period_end?: string;
  };
  await recordAudit(actor, {
    action: 'payout.created',
    targetTable: 'facilitator_payouts',
    targetId: row.id ?? null,
    amountCentavos: row.net_centavos ?? null,
    currency: row.currency ?? 'PHP',
    after: { facilitator_id: row.facilitator_id, status: 'draft' },
    note: `${sessionCount} session${sessionCount === 1 ? '' : 's'}, ${row.period_start ?? '?'} to ${row.period_end ?? '?'}`,
  });
}

async function updatePayout(
  supabase: SupabaseClient,
  payoutId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
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

  // Voiding releases the batch's work back into the unpaid pool, so a mistaken
  // batch can be rebuilt rather than leaving that money unpayable.
  //
  // Released *before* the batch is marked void, for the reason buildPayout
  // orders its writes: choose the failure that stays visible and fixable. If a
  // release fails after the status write, the batch reads `void`, the admin
  // screen stops offering Void, and the rows still stamped with it are excluded
  // from every future batch with no way back. Released first, a failure leaves
  // the batch in its old status with Void still on offer, and re-voiding (which
  // canVoidPayout allows) finishes the job. The window between the two writes
  // is harmless: a batch being voided was never going to be paid.
  if (patch.status === 'void') {
    const decision = canVoidPayout(before.status);
    if (!decision.ok) return json(409, { error: decision.reason });

    for (const table of PAYOUT_CLAIM_TABLES) {
      const { error: releaseError } = await supabase
        .from(table)
        .update({ payout_id: null })
        .eq('payout_id', payoutId);
      if (releaseError) throw releaseError;

      // The clawback claim (0059) is a separate column, so it needs its own
      // release — voiding a batch must undo both what it paid *and* what it
      // took back, or a voided clawback stays permanently unclaimable by any
      // future batch even though the money it was reclaiming was never sent.
      const { error: clawbackReleaseError } = await supabase
        .from(table)
        .update({ [PAYOUT_CLAWBACK_COLUMN]: null })
        .eq(PAYOUT_CLAWBACK_COLUMN, payoutId);
      if (clawbackReleaseError) throw clawbackReleaseError;
    }
  }

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

  await recordAudit(actor, {
    action: patch.status !== undefined && patch.status !== before.status
      ? `payout.${String(patch.status)}`
      : 'payout.updated',
    targetTable: 'facilitator_payouts',
    targetId: payoutId,
    // The amount travels only with the transition that moves money, so the
    // money view shows "paid ₱X" once rather than on every note edit.
    amountCentavos: patch.status === 'paid' && before.status !== 'paid' ? data.net_centavos : null,
    currency: data.currency,
    before: { status: before.status },
    after: patch,
    note: data.reference ? `reference ${data.reference}` : null,
  });

  return ok({ payout: data });
}

/**
 * Group class registrations, for the admin (0051).
 *
 *   GET  /admin/class-registrations             — the roster, filterable
 *   GET  /admin/class-registrations?owed=true   — the refund queue
 *   POST /admin/class-registrations/{id}/refund — record a refund as sent
 *
 * The refund queue is the reason this exists. Cancelling a class date releases
 * everyone's seat and records what each is owed, but moves no money — refunds
 * on this platform are issued by hand, everywhere. Until this endpoint there
 * was no screen anywhere showing an admin which class refunds were
 * outstanding, while the help centre was promising clients one "within a few
 * working days". The promise existed and the queue behind it did not.
 *
 * Deliberately the same two-column ledger bookings use (0014): owed is
 * `refund_centavos > 0 and refunded_at is null`, sent is `refunded_at is not
 * null`. No third state to fall out of step.
 */
const CLASS_REGISTRATION_COLUMNS =
  'id, session_id, facilitator_id, client_email, client_name, status, seat_no, ' +
  'price_centavos, currency, refund_centavos, refunded_at, refund_reference, ' +
  'cancelled_at, cancelled_by, cancellation_reason, payout_id, created_at';

async function classRegistrations(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  method: string,
  path: string,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const registrationId = event.pathParameters?.registrationId;

  if (registrationId && path.endsWith('/refund')) {
    if (method !== 'POST') return badRequest(`Unsupported method ${method}`);
    return await markClassRefundSent(supabase, registrationId, parseBody(event), actor);
  }

  if (method !== 'GET') return badRequest(`Unsupported method ${method}`);

  const owedOnly = (event.queryStringParameters?.owed ?? '') === 'true';

  let query = supabase
    .from('class_registrations')
    .select(
      `${CLASS_REGISTRATION_COLUMNS}, ` +
        'facilitators(slug, display_name, email), ' +
        'facilitator_class_sessions(starts_at, ends_at, status, facilitator_classes(title))',
    )
    .order('created_at', { ascending: false })
    .limit(500);

  if (owedOnly) {
    // Oldest first when working a queue: the refund somebody has been waiting
    // on for a week is the urgent one, and the help centre tells them to chase
    // us at exactly that point.
    query = refundOwed(query).order('cancelled_at', { ascending: true });
  }

  // The embedded relations defeat PostgREST's inferred row type, as on every
  // other joined read in this file.
  const { data, error } = await query.returns<Record<string, unknown>[]>();
  if (error) throw error;

  const rows = data ?? [];
  return ok({
    registrations: rows,
    // Totalled here rather than in the browser so the figure on the screen and
    // the figure in any report come from one place.
    owedTotalCentavos: rows.reduce(
      (total: number, row: Record<string, unknown>) =>
        row.refunded_at ? total : total + Number(row.refund_centavos ?? 0),
      0,
    ),
  });
}

/**
 * Records that a class refund has actually been sent.
 *
 * Mirrors `markRefundSent` for bookings, including the re-asserted
 * `refunded_at is null` on the write: two admins working the queue at once
 * must not both be able to record the same refund, which would read as two
 * payments having gone out.
 */
async function markClassRefundSent(
  supabase: SupabaseClient,
  registrationId: string,
  body: Record<string, unknown>,
  actor: AuditActor,
): Promise<APIGatewayProxyResultV2> {
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 200) : '';
  if (!reference) return badRequest('A payment or bank reference is required');

  const { data: registration, error } = await supabase
    .from('class_registrations')
    .select('id, refund_centavos, refunded_at')
    .eq('id', registrationId)
    .maybeSingle<{ id: string; refund_centavos: number | null; refunded_at: string | null }>();

  if (error) throw error;
  if (!registration) return notFound('Class registration not found');
  if (!registration.refund_centavos || registration.refund_centavos <= 0) {
    return badRequest('No refund is owed on this class registration');
  }
  if (registration.refunded_at) {
    return json(409, { error: 'This refund is already recorded as sent.' });
  }

  const { data: marked, error: updateError } = await supabase
    .from('class_registrations')
    .update({ refunded_at: new Date().toISOString(), refund_reference: reference })
    .eq('id', registrationId)
    .is('refunded_at', null)
    .select('id, refunded_at, refund_reference')
    .maybeSingle<{ id: string; refunded_at: string; refund_reference: string }>();

  if (updateError) throw updateError;
  if (!marked) return json(409, { error: 'This refund is already recorded as sent.' });

  await recordAudit(actor, {
    action: 'class_registration.refund_sent',
    targetTable: 'class_registrations',
    targetId: registrationId,
    amountCentavos: registration.refund_centavos,
    currency: 'PHP',
    after: { refunded_at: marked.refunded_at },
    note: `reference ${marked.refund_reference}`,
  });

  return ok({
    registrationId,
    refundedAt: marked.refunded_at,
    reference: marked.refund_reference,
  });
}

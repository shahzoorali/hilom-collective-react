/**
 * The facilitator's own dashboard API.
 *
 *   POST   /facilitators/apply                     (any signed-in user)
 *   GET    /facilitator/me                         (facilitator group)
 *   PUT    /facilitator/me
 *   GET    /facilitator/services
 *   POST   /facilitator/services
 *   PUT    /facilitator/services/{serviceId}
 *   DELETE /facilitator/services/{serviceId}
 *   GET    /facilitator/availability
 *   PUT    /facilitator/availability
 *   GET    /facilitator/blackouts
 *   POST   /facilitator/blackouts
 *   DELETE /facilitator/blackouts/{blackoutId}
 *   GET    /facilitator/bookings
 *   GET    /facilitator/earnings
 *   POST   /facilitator/bookings/{bookingId}/cancel
 *   POST   /facilitator/bookings/{bookingId}/no-show
 *
 * ## The one rule this file exists to enforce
 *
 * Every query is scoped to the facilitator row that belongs to the *token's*
 * `cognito_sub`. No path or body ever names a facilitator id. That is what
 * stops one facilitator reading another's calendar, client emails or earnings
 * by editing an id in a URL — the most obvious way a multi-tenant dashboard
 * gets this wrong, and the reason `me()` resolves the row once at the top of
 * the handler and every function below takes it as an argument.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, json, notFound, badRequest, unauthorized, serverError } from '../lib/http.js';
import { requireUser, requireGroup, UnauthorizedError } from '../lib/auth.js';
import {
  SERVICE_PUBLIC_COLUMNS,
  previewAvailability,
  type ServiceRow,
  type FacilitatorSchedulingRow,
} from '../lib/scheduling.js';
import { refundForCancellation } from '../lib/booking-domain.js';
import { sendBookingCancelled } from '../lib/booking-email.js';
import { syncBookingMeeting } from '../lib/booking-fulfillment.js';
import {
  validateProfile,
  validateApplication,
  validateService,
  validateAvailability,
  validateBlackout,
  FacilitatorInputError,
} from '../lib/facilitator-input.js';
import { normalizeSlug, slugify, findAvailableFacilitatorSlug, SlugError } from '../lib/slug.js';

const OWN_COLUMNS =
  'id, slug, email, display_name, headline, bio, photo_media_id, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, website_url, years_experience, legal_name, phone, timezone, status, platform_fee_bps, vacation_until, payout_details, applied_at, approved_at';

interface FacilitatorRow {
  id: string;
  slug: string;
  email: string;
  display_name: string;
  timezone: string;
  status: string;
  platform_fee_bps: number;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  // Every branch below is `await`ed deliberately, not just returned — a bare
  // `return asyncFn()` inside a try hands back a *pending* promise before it
  // has rejected, so an inner throw (bad input, a Postgres error) surfaces
  // after this function's own try block has already exited, and the catch
  // below never runs. See the identical note in admin-facilitators.ts, where
  // this was actually caught happening.
  try {
    // The application endpoint is the one route open to any signed-in user —
    // by definition the applicant is not yet in the facilitator group.
    if (path.endsWith('/facilitators/apply')) {
      const user = await requireUser(event);
      return await apply(user, parseBody(event));
    }

    const user = await requireGroup(event, 'facilitator');
    const supabase = await getSupabase();
    const facilitator = await me(supabase, user);
    if (!facilitator) {
      // In the group but with no row: the group was granted without an
      // approved application. Fail closed rather than inventing a profile.
      return notFound('No facilitator profile is linked to this account');
    }

    if (path.endsWith('/facilitator/me')) {
      if (method === 'GET') return ok({ facilitator });
      if (method === 'PUT') return await updateProfile(supabase, facilitator, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/services')) {
      return await services(supabase, facilitator, event, method);
    }

    if (path.endsWith('/facilitator/slot-preview')) {
      if (method === 'GET') return await slotPreview(supabase, facilitator, event);
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/availability')) {
      if (method === 'GET') return await listAvailability(supabase, facilitator);
      if (method === 'PUT') return await replaceAvailability(supabase, facilitator, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/blackouts')) {
      return await blackouts(supabase, facilitator, event, method);
    }

    if (path.includes('/facilitator/bookings')) {
      return await bookings(supabase, facilitator, event, method, path);
    }

    if (path.endsWith('/facilitator/earnings')) {
      return await earnings(supabase, facilitator);
    }

    return notFound();
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    if (err instanceof FacilitatorInputError) return badRequest(err.message);
    if (err instanceof SlugError) return badRequest(err.message);
    return serverError('facilitatorPortal', err);
  }
}

/**
 * Resolves the caller's own facilitator row, linking it to their Cognito
 * identity on the way if it isn't yet.
 *
 * `cognito_sub` is null on any row created before its owner's first sign-in —
 * both a self-submitted application (never signed in until now) and one an
 * admin entered directly (never had a Cognito account to reference at all).
 * The first lookup covers the common case; the fallback is what makes an
 * admin-added facilitator's dashboard actually open rather than 404ing
 * forever, by claiming the matching `email` row the first time its owner
 * signs in and is found to be in the `facilitator` group.
 */
async function me(
  supabase: SupabaseClient,
  user: { email: string; sub: string },
): Promise<(FacilitatorRow & Record<string, unknown>) | null> {
  const { data: bySub, error: subError } = await supabase
    .from('facilitators')
    .select(OWN_COLUMNS)
    .eq('cognito_sub', user.sub)
    .maybeSingle<FacilitatorRow & Record<string, unknown>>();
  if (subError) throw subError;
  if (bySub) return bySub;

  const { data: linked, error: linkError } = await supabase
    .from('facilitators')
    .update({ cognito_sub: user.sub })
    .is('cognito_sub', null)
    .eq('email', user.email)
    .select(OWN_COLUMNS)
    .maybeSingle<FacilitatorRow & Record<string, unknown>>();
  if (linkError) throw linkError;
  return linked;
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new FacilitatorInputError('Request body is not valid JSON');
  }
}

/**
 * Submits an application.
 *
 * Creates the row in `applied` — never `approved`, and never with a
 * `platform_fee_bps` from the body. Status, fee rate and publication are admin
 * decisions, and nothing an applicant can send here touches them.
 *
 * What this writes is *intake*, not profile: how to reach them, how long
 * they've practised, what they want to build, and how involved they want Hilom
 * to be. The public profile columns — credentials, specialties, scope of
 * practice, delivery mode — are left empty on purpose and are filled in by the
 * facilitator in the dashboard Profile tab once approved. That is the whole
 * point of `approved` and `published` being separate statuses: an approved
 * facilitator has dashboard access precisely so they can write that copy
 * before anyone sees it.
 *
 * The practical consequence for review: an `applied` row has no credentials and
 * no scope note, and that is now normal rather than a red flag. Both are
 * checked before Publish instead — see the checklist in FacilitatorsTab.
 *
 * ## Re-applying after a rejection
 *
 * A `rejected` applicant is allowed back in. Rejection is not always final —
 * Hilom sometimes rejects with a reason and asks the person to come back once
 * it is addressed — so the door has to stay open.
 *
 * For now that re-application is a *fresh* one: it overwrites the whole row
 * and resets the status to `applied`. The better flow — come back to a
 * pre-filled form and change only what was flagged — does not exist yet, and
 * building the wrong half of it first (letting someone edit a rejected
 * application in place while an admin still sees the old one) would be worse
 * than starting over. `admin_notes` is deliberately kept, so the reviewer of
 * the second attempt can still see why the first was turned down.
 *
 * Every other status — still queued, approved, live, suspended — is left to
 * the admin flow to move, and a second submission just reports the current
 * one.
 */
async function apply(
  user: { email: string; sub: string; givenName?: string; familyName?: string },
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('facilitators')
    .select('id, status, cognito_sub')
    .or(`cognito_sub.eq.${user.sub},email.eq.${user.email}`)
    .maybeSingle<{ id: string; status: string; cognito_sub: string | null }>();
  if (existingError) throw existingError;
  if (existing && existing.status !== 'rejected') {
    return ok({ alreadyApplied: true, status: existing.status });
  }

  const application = validateApplication({
    ...body,
    display_name:
      body.display_name ?? [user.givenName, user.familyName].filter(Boolean).join(' ') ?? user.email,
  });

  if (existing) {
    const { data, error } = await supabase
      .from('facilitators')
      .update({
        ...application,
        // Links an admin-entered row (cognito_sub null) to the account the
        // first time its owner signs in and re-applies; leaves an existing
        // link alone.
        cognito_sub: existing.cognito_sub ?? user.sub,
        status: 'applied',
        applied_at: new Date().toISOString(),
        approved_at: null,
      })
      .eq('id', existing.id)
      // Re-assert the status: if an admin moved this row out of `rejected`
      // between the read above and this write, the update matches nothing and
      // we report the current state rather than quietly reopening it.
      .eq('status', 'rejected')
      .select('id, slug, status')
      .maybeSingle();
    if (error) throw error;
    if (!data) return ok({ alreadyApplied: true, status: 'applied' });
    return ok({ facilitator: data, status: 'applied', reapplied: true });
  }

  const base = slugify(application.display_name) || 'facilitator';
  const slug = await findAvailableFacilitatorSlug(normalizeSlug(base), async (candidate) => {
    const { data } = await supabase.from('facilitators').select('id').eq('slug', candidate).maybeSingle();
    return Boolean(data);
  });

  const { data, error } = await supabase
    .from('facilitators')
    .insert({
      ...application,
      slug,
      // The account's verified email, never one from the body — the row is
      // keyed to this identity, and an applicant typing a different address
      // would produce a profile whose owner can never open its dashboard.
      email: user.email,
      cognito_sub: user.sub,
      status: 'applied',
    })
    .select('id, slug, status')
    .maybeSingle();

  if (error) throw error;
  return ok({ facilitator: data, status: 'applied' });
}

/**
 * Confirmed sessions that fall inside a vacation window.
 *
 * `vacation_until` only ever stopped *new* bookings — the slot engine reads it
 * as a floor on the earliest bookable instant. Sessions already in the diary
 * when someone sets it stayed exactly where they were, silently, and the
 * facilitator had to notice each one for themselves. This is the half of the
 * feature that was missing.
 *
 * Deliberately reports rather than cancels. Cancelling on the facilitator's
 * behalf would refund clients in full and empty a week of their calendar off
 * the back of a date field — a destructive act triggered by a setting nobody
 * would expect to be destructive. What they need is to be told, with enough
 * detail to decide session by session.
 *
 * Bounded at 50: the banner says "you have N sessions", and nobody is going to
 * read the hundredth row of a list they are about to act on one at a time.
 */
async function vacationConflicts(
  supabase: SupabaseClient,
  facilitatorId: string,
  vacationUntil: string | null,
  now: Date = new Date(),
): Promise<{ id: string; starts_at: string; client_name: string | null; client_email: string; title: string }[]> {
  if (!vacationUntil) return [];
  const until = new Date(vacationUntil);
  // A window that has already closed is not a conflict, it is history.
  if (Number.isNaN(until.getTime()) || until <= now) return [];

  const { data, error } = await supabase
    .from('bookings')
    .select('id, starts_at, client_name, client_email, facilitator_services(title)')
    .eq('facilitator_id', facilitatorId)
    .eq('status', 'confirmed')
    .gte('starts_at', now.toISOString())
    .lt('starts_at', until.toISOString())
    .order('starts_at')
    .limit(50);

  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    starts_at: row.starts_at as string,
    client_name: row.client_name as string | null,
    client_email: row.client_email as string,
    title: row.facilitator_services?.title ?? 'Session',
  }));
}

async function updateProfile(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const profile = validateProfile(body);

  // `status`, `platform_fee_bps`, `slug` and `email` are absent by
  // construction: a facilitator must not be able to publish themselves,
  // renegotiate their own fee, or take another profile's URL.
  const { data, error } = await supabase
    .from('facilitators')
    .update({
      ...profile,
      legal_name: typeof body.legal_name === 'string' ? body.legal_name.trim().slice(0, 160) : null,
      phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : null,
      payout_details:
        body.payout_details && typeof body.payout_details === 'object' ? body.payout_details : undefined,
    })
    .eq('id', facilitator.id)
    .select(OWN_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  // Returned with the save rather than behind a separate fetch: the moment a
  // facilitator sets a vacation date is exactly the moment "you have three
  // sessions in that window" is useful, and a second round trip is a second
  // chance to miss it.
  const conflicts = await vacationConflicts(supabase, facilitator.id, profile.vacation_until);

  return ok({ facilitator: data, vacationConflicts: conflicts });
}

/**
 * The slots a client would actually be offered, and why there are none.
 *
 * The facilitator's own view of `GET /facilitators/{slug}/availability`, with
 * two deliberate differences. It does not require the profile to be
 * `published` or the service to be `is_active` — the whole point is to check
 * the configuration *before* going live, which is exactly when the public
 * endpoint refuses to answer. And it returns findings alongside the slots, so
 * an empty week comes with the reason rather than as a silent shrug.
 *
 * Scoped to the caller's own facilitator row, so this is not a way to inspect
 * anyone else's diary.
 */
async function slotPreview(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters ?? {};
  const serviceId = params.serviceId?.trim();
  if (!serviceId) return badRequest('Missing serviceId');

  const now = new Date();
  const from = params.from ? new Date(params.from) : now;
  const to = params.to ? new Date(params.to) : new Date(now.getTime() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return badRequest('from and to must be ISO-8601 dates');
  }
  if (to <= from) return badRequest('to must be after from');
  // Same bound as the public endpoint: the engine projects weekly rules day by
  // day, and an unbounded range is an unbounded loop.
  if (to.getTime() - from.getTime() > 60 * 86_400_000) {
    return badRequest('Range must not exceed 60 days');
  }

  const { data: service, error } = await supabase
    .from('facilitator_services')
    .select(SERVICE_PUBLIC_COLUMNS)
    .eq('id', serviceId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<ServiceRow>();
  if (error) throw error;
  if (!service) return notFound('Service not found');

  const { data: scheduling, error: schedulingError } = await supabase
    .from('facilitators')
    .select('id, timezone, vacation_until, status')
    .eq('id', facilitator.id)
    .maybeSingle<FacilitatorSchedulingRow>();
  if (schedulingError) throw schedulingError;
  if (!scheduling) return notFound('Facilitator not found');

  const preview = await previewAvailability(supabase, scheduling, service, from, to, now);

  return ok({
    timezone: scheduling.timezone,
    durationMinutes: service.duration_minutes,
    // `blockEndsAt` stays internal here as it does on the public endpoint —
    // the preview must show what a client sees, buffer included in the gaps
    // between slots rather than stated as a longer session.
    slots: preview.slots.map((slot) => ({ startsAt: slot.startsAt, endsAt: slot.endsAt })),
    findings: preview.findings,
    // Flagged rather than inferred from `status`: a service can be inactive on
    // a published profile, and both cases mean "clients cannot see this yet".
    isLive: scheduling.status === 'published' && service.is_active,
  });
}

async function services(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const serviceId = event.pathParameters?.serviceId;
  const columns = `${SERVICE_PUBLIC_COLUMNS}, meeting_url, created_at, updated_at`;

  if (!serviceId) {
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('facilitator_services')
        .select(columns)
        .eq('facilitator_id', facilitator.id)
        .order('sort_order');
      if (error) throw error;
      return ok({ services: data ?? [] });
    }
    if (method === 'POST') {
      const input = validateService(parseBody(event));
      const { data, error } = await supabase
        .from('facilitator_services')
        .insert({ ...input, facilitator_id: facilitator.id })
        .select(columns)
        .maybeSingle();
      if (error) {
        // The partial unique index from 0011 — a second active free call.
        if (error.code === '23505') {
          return badRequest('You already have an active complimentary call. Edit that one instead.');
        }
        throw error;
      }
      return ok({ service: data });
    }
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PUT') {
    const input = validateService(parseBody(event));
    const { data, error } = await supabase
      .from('facilitator_services')
      .update(input)
      .eq('id', serviceId)
      // Scoped: a service id belonging to someone else matches nothing.
      .eq('facilitator_id', facilitator.id)
      .select(columns)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') {
        return badRequest('You already have an active complimentary call. Edit that one instead.');
      }
      throw error;
    }
    if (!data) return notFound('Service not found');
    return ok({ service: data });
  }

  if (method === 'DELETE') {
    // Deactivate rather than delete. `bookings.service_id` is ON DELETE
    // RESTRICT precisely so that history cannot be destroyed by tidying up a
    // service list — a past session must stay attributable to what was sold.
    const { data, error } = await supabase
      .from('facilitator_services')
      .update({ is_active: false })
      .eq('id', serviceId)
      .eq('facilitator_id', facilitator.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return notFound('Service not found');
    return ok({ deactivated: true });
  }

  return badRequest(`Unsupported method ${method}`);
}

async function listAvailability(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_availability')
    .select('id, weekday, start_minute, end_minute')
    .eq('facilitator_id', facilitator.id)
    .order('weekday')
    .order('start_minute');
  if (error) throw error;
  return ok({ windows: data ?? [], timezone: facilitator.timezone });
}

/**
 * Replaces the whole weekly grid.
 *
 * Delete-then-insert rather than a diff because the dashboard edits the week as
 * one object. The two statements are not in a transaction — PostgREST has no
 * multi-statement transaction — so a failure between them leaves the
 * facilitator with no availability. That is the safe direction to fail: no
 * availability means no new bookings, whereas a partial grid would quietly
 * offer hours nobody agreed to. Existing bookings are untouched either way.
 */
async function replaceAvailability(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const windows = validateAvailability(body);

  const { error: deleteError } = await supabase
    .from('facilitator_availability')
    .delete()
    .eq('facilitator_id', facilitator.id);
  if (deleteError) throw deleteError;

  if (windows.length > 0) {
    const { error: insertError } = await supabase
      .from('facilitator_availability')
      .insert(windows.map((w) => ({ ...w, facilitator_id: facilitator.id })));
    if (insertError) throw insertError;
  }

  return listAvailability(supabase, facilitator);
}

async function blackouts(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const blackoutId = event.pathParameters?.blackoutId;

  if (!blackoutId) {
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('facilitator_blackouts')
        .select('id, starts_at, ends_at, reason')
        .eq('facilitator_id', facilitator.id)
        .order('starts_at');
      if (error) throw error;
      return ok({ blackouts: data ?? [] });
    }
    if (method === 'POST') {
      const input = validateBlackout(parseBody(event));
      const { data, error } = await supabase
        .from('facilitator_blackouts')
        .insert({ ...input, facilitator_id: facilitator.id })
        .select('id, starts_at, ends_at, reason')
        .maybeSingle();
      if (error) throw error;
      // Deliberately does not cancel bookings already inside the range. A
      // blackout blocks *new* bookings; silently cancelling sessions someone
      // has paid for and put in their calendar is not something a date-picker
      // should do. The facilitator cancels those explicitly, which notifies
      // the client and records a refund.
      return ok({ blackout: data });
    }
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'DELETE') {
    const { error } = await supabase
      .from('facilitator_blackouts')
      .delete()
      .eq('id', blackoutId)
      .eq('facilitator_id', facilitator.id);
    if (error) throw error;
    return ok({ deleted: true });
  }

  return badRequest(`Unsupported method ${method}`);
}

const FACILITATOR_BOOKING_COLUMNS =
  'id, service_id, service_kind, client_email, client_name, client_timezone, client_notes, starts_at, ends_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, meeting_url, cancelled_at, cancelled_by, cancellation_reason, refund_centavos, payout_id, created_at';

async function bookings(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const bookingId = event.pathParameters?.bookingId;

  if (!bookingId) {
    if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
    const { data, error } = await supabase
      .from('bookings')
      .select(`${FACILITATOR_BOOKING_COLUMNS}, facilitator_services(title, duration_minutes)`)
      .eq('facilitator_id', facilitator.id)
      .neq('status', 'pending_payment')
      .order('starts_at', { ascending: false });
    if (error) throw error;
    return ok({ bookings: data ?? [], timezone: facilitator.timezone });
  }

  if (method !== 'POST') return badRequest(`Unsupported method ${method}`);

  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`${FACILITATOR_BOOKING_COLUMNS}, facilitator_services(title)`)
    .eq('id', bookingId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<any>();
  if (error) throw error;
  if (!booking) return notFound('Booking not found');

  const now = new Date();

  if (path.endsWith('/no-show')) {
    // Only after the fact — marking a future session as a no-show is either a
    // mistake or an attempt to keep the fee without holding the session.
    if (new Date(booking.ends_at) > now) return badRequest('That session has not happened yet');
    if (booking.status !== 'confirmed' && booking.status !== 'completed') {
      return badRequest('Only a completed session can be marked as a no-show');
    }
    const { data: marked, error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'no_show' })
      .eq('id', bookingId)
      .eq('facilitator_id', facilitator.id)
      // Re-asserted on the write, not just checked on the read above: `no_show`
      // is a *payable* status, so without this a booking the client cancelled
      // between that read and this write could be flipped back into one the
      // facilitator gets paid for.
      .in('status', ['confirmed', 'completed'])
      .select('id')
      .maybeSingle<{ id: string }>();
    if (updateError) throw updateError;
    if (!marked) return badRequest('That booking is no longer one that can be marked as a no-show');
    return ok({ bookingId, status: 'no_show' });
  }

  if (path.endsWith('/cancel')) {
    if (booking.status !== 'confirmed') return badRequest('Only a confirmed booking can be cancelled');

    // Always a full refund when the facilitator cancels, regardless of notice.
    const decision = refundForCancellation({
      priceCentavos: booking.price_centavos,
      startsAt: new Date(booking.starts_at),
      now,
      cancelledBy: 'facilitator',
    });

    const reason =
      typeof parseBody(event).reason === 'string'
        ? String(parseBody(event).reason).slice(0, 500)
        : decision.reason;

    const { data: cancelled, error: updateError } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled_by_facilitator',
        cancelled_at: now.toISOString(),
        cancelled_by: 'facilitator',
        cancellation_reason: reason,
        refund_centavos: decision.refundCentavos,
      })
      .eq('id', bookingId)
      .eq('facilitator_id', facilitator.id)
      .eq('status', 'confirmed')
      // Without reading the row back, a client cancellation landing first goes
      // unnoticed here: this path would still email the client "the facilitator
      // cancelled, refunded in full" while the database holds the client's own
      // partial refund. The two sides would disagree about money.
      .select('id')
      .maybeSingle<{ id: string }>();
    if (updateError) throw updateError;
    if (!cancelled) {
      return json(409, { error: 'That booking was already cancelled.' });
    }

    // Tear down the provider-hosted meeting if there is one. Non-blocking.
    await syncBookingMeeting(supabase, bookingId, 'cancelled');

    await sendBookingCancelled(
      {
        clientEmail: booking.client_email,
        clientName: booking.client_name,
        facilitatorEmail: facilitator.email,
        facilitatorName: facilitator.display_name,
        facilitatorTimezone: facilitator.timezone,
        clientTimezone: booking.client_timezone,
        serviceTitle: booking.facilitator_services?.title ?? 'Session',
        startsAt: booking.starts_at,
        meetingUrl: booking.meeting_url,
        isFree: booking.price_centavos === 0,
      },
      { cancelledBy: 'facilitator', refundNote: decision.reason },
    );

    return ok({ bookingId, status: 'cancelled_by_facilitator', refundCentavos: decision.refundCentavos });
  }

  return notFound();
}

/**
 * The earnings summary: this month, and what is owed but not yet paid out.
 *
 * Deliberately explicit about the split rather than showing a single net
 * figure. A facilitator who cannot see the fee they are paying does not trust
 * the number, and that mistrust is the thing that loses a marketplace its
 * supply side.
 */
async function earnings(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Only sessions that actually happened count. A no-show still earns — the
  // facilitator held the time — but a cancellation does not.
  const EARNING_STATUSES = ['confirmed', 'completed', 'no_show'];

  const [monthRes, unpaidRes, payoutRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('price_centavos, platform_fee_centavos, facilitator_net_centavos, status')
      .eq('facilitator_id', facilitator.id)
      .in('status', EARNING_STATUSES)
      .gte('starts_at', monthStart),
    supabase
      .from('bookings')
      .select('price_centavos, platform_fee_centavos, facilitator_net_centavos')
      .eq('facilitator_id', facilitator.id)
      .in('status', ['completed', 'no_show'])
      .is('payout_id', null),
    supabase
      .from('facilitator_payouts')
      .select('id, period_start, period_end, gross_centavos, platform_fee_centavos, processing_fee_centavos, net_centavos, status, paid_at, reference')
      .eq('facilitator_id', facilitator.id)
      .order('period_end', { ascending: false })
      .limit(12),
  ]);

  if (monthRes.error) throw monthRes.error;
  if (unpaidRes.error) throw unpaidRes.error;
  if (payoutRes.error) throw payoutRes.error;

  interface Totals {
    sessions: number;
    gross: number;
    fees: number;
    net: number;
  }

  const sum = (rows: Record<string, unknown>[] | null): Totals =>
    (rows ?? []).reduce<Totals>(
      (acc, row) => ({
        sessions: acc.sessions + 1,
        gross: acc.gross + Number(row.price_centavos ?? 0),
        fees: acc.fees + Number(row.platform_fee_centavos ?? 0),
        net: acc.net + Number(row.facilitator_net_centavos ?? 0),
      }),
      { sessions: 0, gross: 0, fees: 0, net: 0 },
    );

  return ok({
    thisMonth: sum(monthRes.data),
    awaitingPayout: sum(unpaidRes.data),
    platformFeeBps: facilitator.platform_fee_bps,
    payouts: payoutRes.data ?? [],
  });
}

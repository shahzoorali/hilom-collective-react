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
  releaseExpiredHolds,
  verifySlot,
  type ServiceRow,
  type FacilitatorSchedulingRow,
} from '../lib/scheduling.js';
import {
  refundForCancellation,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
} from '../lib/booking-domain.js';
import { sendBookingCancelled, sendRescheduleProposed } from '../lib/booking-email.js';
import { confirmBooking, syncBookingMeeting } from '../lib/booking-fulfillment.js';
import {
  listMessages,
  markThreadRead,
  postMessage,
  MessageError,
} from '../lib/booking-messages.js';
import {
  validateProfile,
  validateApplication,
  validateService,
  validateAvailability,
  validateBlackout,
  FacilitatorInputError,
} from '../lib/facilitator-input.js';
import { normalizeSlug, slugify, findAvailableFacilitatorSlug, SlugError } from '../lib/slug.js';
import { randomBytes } from 'node:crypto';

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

    if (path.endsWith('/facilitator/calendar-feed')) {
      return await calendarFeedToken(supabase, facilitator, method);
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

    if (path.endsWith('/facilitator/messages')) {
      if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
      return await messageInbox(supabase, facilitator);
    }

    if (path.includes('/facilitator/clients')) {
      return await clients(supabase, facilitator, event, method);
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
    if (err instanceof MessageError) return badRequest(err.message);
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
 * The facilitator's subscribable calendar URL: read it, create it, rotate it,
 * or turn it off.
 *
 *   GET    — the current URL, or null if they have never subscribed
 *   POST   — create one, or rotate the existing one
 *   DELETE — revoke; every subscribed client stops updating
 *
 * Created on demand rather than at approval so a facilitator who never uses
 * the feature never has a bearer token in the database to leak. Rotation and
 * revocation are the same operation from the caller's side — write a new
 * secret, or none — and are the entire remedy for a URL shared by accident,
 * which is why POST is offered even when a token already exists.
 */
async function calendarFeedToken(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  // The API's own origin, not the site's: the feed is served by this API, and
  // a calendar client will fetch exactly the string handed to it here.
  const base = process.env.API_BASE_URL ?? 'https://api.hilomcollective.com';
  const feedUrl = (token: string | null) =>
    token ? `${base}/facilitator-calendar/${token}.ics` : null;

  if (method === 'GET') {
    const { data, error } = await supabase
      .from('facilitators')
      .select('calendar_token')
      .eq('id', facilitator.id)
      .maybeSingle<{ calendar_token: string | null }>();
    if (error) throw error;
    return ok({ url: feedUrl(data?.calendar_token ?? null) });
  }

  if (method === 'POST') {
    // 32 bytes from the CSPRNG. This is the only thing standing between a URL
    // and someone's diary, so it is not derived from anything guessable — not
    // the facilitator id, not a timestamp.
    const token = randomBytes(32).toString('hex');
    const { error } = await supabase
      .from('facilitators')
      .update({ calendar_token: token })
      .eq('id', facilitator.id);
    if (error) throw error;
    return ok({ url: feedUrl(token) });
  }

  if (method === 'DELETE') {
    const { error } = await supabase
      .from('facilitators')
      .update({ calendar_token: null })
      .eq('id', facilitator.id);
    if (error) throw error;
    return ok({ url: null });
  }

  return badRequest(`Unsupported method ${method}`);
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
  'id, service_id, service_kind, client_email, client_name, client_timezone, client_notes, starts_at, ends_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, meeting_url, cancelled_at, cancelled_by, cancellation_reason, refund_centavos, proposed_starts_at, proposed_at, proposed_note, booked_by, off_platform_centavos, facilitator_note, intake_answers, intake_completed_at, session_notes, package_id, payout_id, created_at';

/**
 * A facilitator offers the client a different time, or withdraws the offer.
 *
 * The alternative this replaces is cancelling — which refunds the client in
 * full, releases the hour and leaves them to find another slot themselves.
 * "Something came up, could we do Thursday?" should not cost a facilitator the
 * booking.
 *
 * It is an *offer*, not a move: nothing about the booking changes here beyond
 * three columns that record what was suggested. The client accepts (or does
 * not) from their own bookings page, and only then does the session shift. A
 * platform where one party can move the other's committed hour is not one the
 * other party keeps using.
 *
 * The proposed slot is validated now and validated *again* on acceptance,
 * because it is not held in the meantime — see 0029 for why holding it would
 * be worse than losing the occasional race.
 */
async function proposeTime(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  booking: any,
  event: APIGatewayProxyEventV2,
  path: string,
  now: Date,
): Promise<APIGatewayProxyResultV2> {
  const bookingId = booking.id as string;

  if (path.endsWith('/withdraw-proposal')) {
    const { error } = await supabase
      .from('bookings')
      .update({ proposed_starts_at: null, proposed_at: null, proposed_note: null })
      .eq('id', bookingId)
      .eq('facilitator_id', facilitator.id);
    if (error) throw error;
    // Silent for the client: an offer they may not have read yet, taken back.
    // Emailing "never mind" about a message they might not have seen is noise.
    return ok({ bookingId, proposedStartsAt: null });
  }

  if (booking.status !== 'confirmed') return badRequest('Only a confirmed booking can be moved');
  if (new Date(booking.starts_at) <= now) return badRequest('That session has already started');

  const body = parseBody(event);
  const startsAtRaw = typeof body.startsAt === 'string' ? body.startsAt : '';
  const startsAt = new Date(startsAtRaw);
  if (!startsAtRaw || Number.isNaN(startsAt.getTime())) {
    return badRequest('startsAt must be an ISO-8601 date');
  }
  if (startsAt <= now) return badRequest('Suggest a time in the future');
  const noteText = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

  const { data: service, error: serviceError } = await supabase
    .from('facilitator_services')
    .select(SERVICE_PUBLIC_COLUMNS)
    .eq('id', booking.service_id)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<ServiceRow>();
  if (serviceError) throw serviceError;
  if (!service) return notFound('Service not found');

  const { data: scheduling, error: schedulingError } = await supabase
    .from('facilitators')
    .select('id, timezone, vacation_until, status')
    .eq('id', facilitator.id)
    .maybeSingle<FacilitatorSchedulingRow>();
  if (schedulingError) throw schedulingError;
  if (!scheduling) return notFound('Facilitator not found');

  await releaseExpiredHolds(supabase, facilitator.id, now);

  // Checked against the facilitator's *own* rules, excluding this booking so
  // it does not block itself. Two deliberate differences from the client's
  // reschedule: the minimum-notice rule is the facilitator's own hours to give
  // away, and there is no notice threshold on making the offer at all — a
  // facilitator who has to move a session tomorrow morning is exactly who this
  // is for. What protects the client is that they can simply say no.
  const slot = await verifySlot(supabase, scheduling, service, startsAt, now, bookingId);
  if (!slot) return json(409, { error: 'That time is not free in your calendar' });

  const { data: updated, error } = await supabase
    .from('bookings')
    .update({
      proposed_starts_at: slot.startsAt,
      proposed_at: now.toISOString(),
      proposed_note: noteText,
    })
    .eq('id', bookingId)
    .eq('facilitator_id', facilitator.id)
    // Loses cleanly if the client cancelled while this was being composed.
    .eq('status', 'confirmed')
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  if (!updated) return json(409, { error: 'That booking is no longer confirmed.' });

  await sendRescheduleProposed(
    {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      clientTimezone: booking.client_timezone,
      facilitatorEmail: facilitator.email,
      facilitatorName: facilitator.display_name,
      facilitatorTimezone: facilitator.timezone,
      serviceTitle: booking.facilitator_services?.title ?? 'Session',
      startsAt: booking.starts_at,
      meetingUrl: booking.meeting_url,
      isFree: booking.price_centavos === 0,
    },
    { proposedStartsAt: slot.startsAt, note: noteText },
  );

  return ok({ bookingId, proposedStartsAt: slot.startsAt, proposedNote: noteText });
}

/**
 * A facilitator books a client in themselves.
 *
 * Covers what the public paid flow does not: someone who paid by bank transfer
 * or in cash, a pro-bono session, a goodwill rebooking after a cancellation, a
 * long-standing client who has always just texted to arrange the next one.
 *
 * Confirmed immediately — there is no payment to wait for — which means it goes
 * through `confirmBooking` exactly as a paid booking does, so the meeting link
 * is created in the facilitator's connected account and both parties are
 * emailed. A session arranged this way should be indistinguishable from any
 * other once it exists; only how it came to exist differs.
 *
 * **The money is recorded as zero, deliberately.** See 0031: a session paid for
 * off-platform must not enter the payout pipeline, because payouts disburse
 * money Hilom actually collected. What the client paid the facilitator directly
 * is kept in `off_platform_centavos` as a note for their own bookkeeping, and
 * is read by nothing that moves money.
 *
 * The client does not need a Hilom account. Bookings are keyed by email, not by
 * a user row, so anyone signing in later with that address finds the session
 * waiting in their bookings — the same way a booking made before someone signed
 * up behaves.
 */
async function createForClient(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);

  const clientEmail = typeof body.clientEmail === 'string' ? body.clientEmail.trim().toLowerCase() : '';
  // Deliberately permissive — this is a facilitator typing a client's address,
  // not an untrusted signup — but it must be an address, because it is both the
  // identity on the booking and where the confirmation goes.
  if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || clientEmail.length > 254) {
    return badRequest('A valid client email is required');
  }
  const clientName = typeof body.clientName === 'string' ? body.clientName.trim().slice(0, 160) : null;
  const facilitatorNote =
    typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null;

  const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
  const startsAtRaw = typeof body.startsAt === 'string' ? body.startsAt : '';
  const startsAt = new Date(startsAtRaw);
  if (!serviceId || !startsAtRaw || Number.isNaN(startsAt.getTime())) {
    return badRequest('serviceId and an ISO-8601 startsAt are required');
  }

  const now = new Date();
  if (startsAt <= now) return badRequest('Book a time in the future');

  // Pesos in, centavos out — the same conversion the service editor does, kept
  // at the edge so nothing downstream ever sees a fractional centavo.
  let offPlatformCentavos: number | null = null;
  if (body.offPlatformPesos !== undefined && body.offPlatformPesos !== null && body.offPlatformPesos !== '') {
    const pesos = Number(body.offPlatformPesos);
    if (!Number.isFinite(pesos) || pesos < 0) return badRequest('What they paid must be a number');
    offPlatformCentavos = Math.round(pesos * 100);
  }

  const { data: service, error: serviceError } = await supabase
    .from('facilitator_services')
    .select(`${SERVICE_PUBLIC_COLUMNS}, meeting_url`)
    .eq('id', serviceId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<ServiceRow>();
  if (serviceError) throw serviceError;
  if (!service) return notFound('Service not found');
  // Same guard as the public flow: a package charges for N sessions and
  // delivers one, so it must not be bookable by any route.
  if (service.kind === 'package') return badRequest('Multi-session packages are not bookable yet.');

  const { data: scheduling, error: schedulingError } = await supabase
    .from('facilitators')
    .select('id, timezone, vacation_until, status')
    .eq('id', facilitator.id)
    .maybeSingle<FacilitatorSchedulingRow>();
  if (schedulingError) throw schedulingError;
  if (!scheduling) return notFound('Facilitator not found');

  await releaseExpiredHolds(supabase, facilitator.id, now);

  // Checked against the same engine as a public booking, with one exception.
  // The weekly grid, blackouts, notice period and daily cap all still govern:
  // a facilitator entering a booking by hand has decided this one is fine, but
  // there is no reason to invent a second notion of "free hour" alongside the
  // one the exclusion constraint enforces.
  const slot = await verifySlot(
    supabase,
    // Vacation is the exception. Booking a client into a week you are away is
    // either a mistake you will catch on the confirmation screen, or exactly
    // the exception you opened this form to make.
    { ...scheduling, vacation_until: null },
    service,
    startsAt,
    now,
  );
  if (!slot) return json(409, { error: 'That time is not free — pick another' });

  const { data: booking, error: insertError } = await supabase
    .from('bookings')
    .insert({
      facilitator_id: facilitator.id,
      service_id: service.id,
      service_kind: service.kind,
      client_email: clientEmail,
      client_name: clientName,
      starts_at: slot.startsAt,
      ends_at: slot.blockEndsAt,
      // No payment to wait for.
      status: 'confirmed',
      // Zero, and not a rounding of anything. See 0031.
      price_centavos: 0,
      platform_fee_centavos: 0,
      facilitator_net_centavos: 0,
      currency: service.currency,
      meeting_url: service.meeting_url ?? null,
      refund_full_hours: service.refund_full_hours ?? 24,
      refund_half_hours: service.refund_half_hours ?? 12,
      booked_by: 'facilitator',
      // No intake: the client was never shown the form. They can still fill it
      // in from their own bookings page before the session.
      off_platform_centavos: offPlatformCentavos,
      facilitator_note: facilitatorNote,
    })
    .select('id')
    .maybeSingle<{ id: string }>();

  if (insertError) {
    // Both are ordinary outcomes of a human filling in a form, not faults.
    if (insertError.code === EXCLUSION_VIOLATION) {
      return json(409, { error: 'Something else is already booked at that time' });
    }
    if (insertError.code === UNIQUE_VIOLATION) {
      return json(409, {
        error:
          'That client has already had their complimentary call with you — book a paid session instead.',
      });
    }
    throw insertError;
  }
  if (!booking) throw new Error('Booking insert returned no row');

  // The same fulfilment path as a paid booking: meeting link created in the
  // facilitator's account, both parties emailed.
  await confirmBooking(booking.id);

  return ok({ bookingId: booking.id, status: 'confirmed', startsAt: slot.startsAt });
}

/**
 * The facilitator's view of a client, rather than of a booking (0033).
 *
 *   GET   /facilitator/clients             — everyone they have seen
 *   GET   /facilitator/clients/{email}     — one person's timeline and notes
 *   PUT   /facilitator/clients/{email}     — the standing "about" note
 *   PUT   /facilitator/bookings/{id}/notes — what happened in one session
 *
 * The list is derived rather than stored. There is no client entity in this
 * schema — a client is an email on a booking, the same as a course buyer is an
 * email on an order — and inventing one here would mean keeping it in step with
 * every booking write for the sake of a query that is a group-by.
 */

/** What the client list needs about one person. */
interface ClientSummary {
  email: string;
  name: string | null;
  sessions: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  nextSessionAt: string | null;
  /**
   * What this facilitator has actually earned from them, through Hilom. Excludes
   * sessions they entered by hand, which carry zero on purpose (0031).
   */
  netCentavos: number;
  hasAbout: boolean;
}

/** Statuses that mean a session was real: held, or held and not attended. */
const DELIVERED = new Set(['confirmed', 'completed', 'no_show']);

async function clients(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  // Path-encoded so a client's address never appears in a query string, which
  // is the one place URLs reliably end up in logs and referrers.
  const rawEmail = event.pathParameters?.clientEmail;
  const clientEmail = rawEmail ? decodeURIComponent(rawEmail).trim().toLowerCase() : '';

  if (!clientEmail) {
    if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
    return await listClients(supabase, facilitator);
  }

  if (method === 'GET') return await clientDetail(supabase, facilitator, clientEmail);
  if (method === 'PUT') return await saveClientAbout(supabase, facilitator, clientEmail, event);
  return badRequest(`Unsupported method ${method}`);
}

/**
 * Everyone this facilitator has seen, most recent first.
 *
 * Grouped in memory rather than in SQL. PostgREST cannot express the group-by
 * this needs without a database view or an RPC, and one facilitator's bookings
 * is a list in the hundreds — a size where the round trip costs more than the
 * loop does.
 */
async function listClients(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  const [bookingRes, aboutRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('client_email, client_name, starts_at, status, facilitator_net_centavos')
      .eq('facilitator_id', facilitator.id)
      // A lapsed hold was never a client.
      .neq('status', 'pending_payment')
      .order('starts_at', { ascending: false })
      .limit(2000),
    supabase
      .from('facilitator_clients')
      .select('client_email, about')
      .eq('facilitator_id', facilitator.id),
  ]);

  if (bookingRes.error) throw bookingRes.error;
  if (aboutRes.error) throw aboutRes.error;

  const withAbout = new Set(
    (aboutRes.data ?? [])
      .filter((row) => typeof row.about === 'string' && row.about.trim())
      .map((row) => String(row.client_email).toLowerCase()),
  );

  const now = Date.now();
  const byEmail = new Map<string, ClientSummary>();

  for (const row of bookingRes.data ?? []) {
    const email = String(row.client_email).toLowerCase();
    const startsAt = String(row.starts_at);
    const delivered = DELIVERED.has(String(row.status));
    const isFuture = new Date(startsAt).getTime() > now;

    const current =
      byEmail.get(email) ??
      ({
        email,
        name: null,
        sessions: 0,
        firstSessionAt: null,
        lastSessionAt: null,
        nextSessionAt: null,
        netCentavos: 0,
        hasAbout: withAbout.has(email),
      } satisfies ClientSummary);

    // The most recent name they gave wins — rows arrive newest first, so the
    // first non-null is it. Someone who married between sessions should not be
    // filed under their old name forever.
    if (!current.name && row.client_name) current.name = String(row.client_name);

    if (delivered) {
      current.sessions += 1;
      current.netCentavos += Number(row.facilitator_net_centavos ?? 0);
      // Descending order, so the first delivered row is the latest and the
      // last one seen is the earliest.
      if (!current.lastSessionAt && !isFuture) current.lastSessionAt = startsAt;
      if (!isFuture) current.firstSessionAt = startsAt;
      // Likewise: the *last* future row seen is the soonest one.
      if (isFuture) current.nextSessionAt = startsAt;
    }

    byEmail.set(email, current);
  }

  // Someone with a session tomorrow is more interesting than someone last seen
  // in March, so upcoming sorts first; otherwise by recency.
  const list = [...byEmail.values()].sort((a, b) => {
    if (a.nextSessionAt && b.nextSessionAt) return a.nextSessionAt.localeCompare(b.nextSessionAt);
    if (a.nextSessionAt) return -1;
    if (b.nextSessionAt) return 1;
    return (b.lastSessionAt ?? '').localeCompare(a.lastSessionAt ?? '');
  });

  return ok({ clients: list });
}

/**
 * One client: every session with this facilitator, and both kinds of note.
 *
 * The timeline is the answer to "what have we done" — which is the question a
 * facilitator has thirty seconds before a session with someone they last saw
 * six weeks ago, and which the bookings list could never answer because it is
 * ordered by time rather than by person.
 */
async function clientDetail(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  clientEmail: string,
): Promise<APIGatewayProxyResultV2> {
  const [bookingRes, aboutRes] = await Promise.all([
    supabase
      .from('bookings')
      .select(
        'id, starts_at, ends_at, status, price_centavos, facilitator_net_centavos, off_platform_centavos, ' +
          'booked_by, client_name, client_notes, session_notes, intake_answers, intake_completed_at, ' +
          'facilitator_services(title, duration_minutes)',
      )
      .eq('facilitator_id', facilitator.id)
      // `lower()` on both sides, matching the unique index: a client who typed
      // their address with a capital once must not become a second person.
      .ilike('client_email', clientEmail)
      .neq('status', 'pending_payment')
      .order('starts_at', { ascending: false }),
    supabase
      .from('facilitator_clients')
      .select('about, updated_at')
      .eq('facilitator_id', facilitator.id)
      .ilike('client_email', clientEmail)
      .maybeSingle<{ about: string | null; updated_at: string }>(),
  ]);

  if (bookingRes.error) throw bookingRes.error;
  if (aboutRes.error) throw aboutRes.error;

  // `any[]` because the embedded relation defeats PostgREST's inferred row
  // type, exactly as it does on every other joined read in this file.
  const bookings = (bookingRes.data ?? []) as any[];
  // Nobody by that address has ever booked with this facilitator. Not found
  // rather than an empty timeline: an empty page for an address they have
  // never seen is a way to probe whether it exists.
  if (bookings.length === 0 && !aboutRes.data) return notFound('No client by that address');

  return ok({
    email: clientEmail,
    name: bookings.find((row) => row.client_name)?.client_name ?? null,
    about: aboutRes.data?.about ?? null,
    aboutUpdatedAt: aboutRes.data?.updated_at ?? null,
    bookings,
  });
}

/** The standing note. Upserted, because "no note yet" and "an empty note" are the same thing. */
async function saveClientAbout(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  clientEmail: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const about = typeof body.about === 'string' ? body.about.trim().slice(0, 10_000) : '';

  // Only for someone they have actually seen. Without this the endpoint is a
  // notepad addressable by any email, which is both a storage vector and a way
  // to write a record about a person with no relationship to this facilitator.
  const { count, error: countError } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('facilitator_id', facilitator.id)
    .ilike('client_email', clientEmail)
    .neq('status', 'pending_payment');
  if (countError) throw countError;
  if (!count) return notFound('No client by that address');

  const { error } = await supabase.from('facilitator_clients').upsert(
    {
      facilitator_id: facilitator.id,
      client_email: clientEmail,
      about: about || null,
    },
    // Matches the unique index in 0033. Without naming it, a second save would
    // insert a duplicate rather than updating the note.
    { onConflict: 'facilitator_id,client_email' },
  );
  if (error) throw error;

  return ok({ about: about || null });
}

/**
 * What happened in one session (0033).
 *
 * Private to the facilitator and never returned by any client-facing handler —
 * see the disclosure note in the migration. Writable at any time, including
 * before the session: a facilitator preparing for one is exactly as entitled to
 * write in it as one reflecting afterwards.
 */
async function saveSessionNotes(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  bookingId: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event);
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 20_000) : '';

  const { data, error } = await supabase
    .from('bookings')
    .update({ session_notes: notes || null })
    .eq('id', bookingId)
    // The whole of the authorization: a booking that is not this facilitator's
    // matches nothing and comes back as a 404.
    .eq('facilitator_id', facilitator.id)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw error;
  if (!data) return notFound('Booking not found');

  return ok({ bookingId, sessionNotes: notes || null });
}

/**
 * The facilitator's half of a booking's message thread, and their inbox (0034).
 *
 *   GET  /facilitator/messages                     — threads with something in them
 *   GET  /facilitator/bookings/{id}/messages       — one conversation
 *   POST /facilitator/bookings/{id}/messages       — reply
 *
 * The inbox exists because a facilitator's unit of attention is not the
 * booking. Someone with a full week does not open twelve sessions to find out
 * whether anyone has asked them anything; they want the one list that says who
 * is waiting on a reply.
 */
async function messageInbox(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  // Every message on this facilitator's bookings, newest first. Bounded rather
  // than paginated: an inbox is a thing you clear, and a facilitator who is
  // 500 messages behind has a different problem than pagination solves.
  const { data, error } = await supabase
    .from('booking_messages')
    .select('id, booking_id, sender, body, created_at, read_at, bookings!inner(facilitator_id)')
    .eq('bookings.facilitator_id', facilitator.id)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  // Collapsed to one row per booking in memory. PostgREST cannot express
  // "latest message per booking" without a view, and this is a few hundred rows.
  const threads = new Map<
    string,
    { bookingId: string; lastMessage: string; lastSender: string; lastAt: string; unread: number }
  >();

  for (const row of (data ?? []) as any[]) {
    const bookingId = String(row.booking_id);
    const existing = threads.get(bookingId);
    // Descending order, so the first row seen for a booking is its latest.
    const thread = existing ?? {
      bookingId,
      lastMessage: String(row.body),
      lastSender: String(row.sender),
      lastAt: String(row.created_at),
      unread: 0,
    };
    // Unread means "written by the client and not yet opened by me" — a
    // facilitator's own messages are never unread to themselves.
    if (row.sender === 'client' && row.read_at === null) thread.unread += 1;
    threads.set(bookingId, thread);
  }

  if (threads.size === 0) return ok({ threads: [] });

  // The session each thread is about. Fetched in one query rather than joined
  // through the message read, which would repeat the booking on every row.
  const { data: bookings, error: bookingError } = await supabase
    .from('bookings')
    .select('id, starts_at, status, client_name, client_email, facilitator_services(title)')
    .in('id', [...threads.keys()]);
  if (bookingError) throw bookingError;

  const byId = new Map((bookings ?? []).map((row: any) => [String(row.id), row]));

  const list = [...threads.values()]
    .map((thread) => {
      const booking = byId.get(thread.bookingId);
      return {
        ...thread,
        startsAt: booking?.starts_at ?? null,
        status: booking?.status ?? null,
        clientName: booking?.client_name ?? null,
        clientEmail: booking?.client_email ?? null,
        serviceTitle: booking?.facilitator_services?.title ?? 'Session',
      };
    })
    // Anything unread first, then by recency. A reply someone is waiting on
    // outranks a conversation that ended a week ago.
    .sort((a, b) => {
      if (Boolean(a.unread) !== Boolean(b.unread)) return a.unread ? -1 : 1;
      return b.lastAt.localeCompare(a.lastAt);
    });

  return ok({ threads: list });
}

/** One thread, from the facilitator's side. Ownership is the booking's. */
async function facilitatorMessages(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  booking: any,
  method: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const bookingId = booking.id as string;

  if (method === 'GET') {
    const thread = await listMessages(supabase, bookingId);
    await markThreadRead(supabase, bookingId, 'facilitator');
    return ok({ messages: thread });
  }

  if (method !== 'POST') return badRequest(`Unsupported method ${method}`);

  if (booking.status !== 'confirmed' && booking.status !== 'completed' && booking.status !== 'no_show') {
    return badRequest('This session is no longer active, so the conversation is closed.');
  }

  const message = await postMessage(supabase, {
    bookingId,
    sender: 'facilitator',
    senderEmail: facilitator.email,
    body: parseBody(event).body,
    notify: {
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      clientTimezone: booking.client_timezone,
      facilitatorEmail: facilitator.email,
      facilitatorName: facilitator.display_name,
      facilitatorTimezone: facilitator.timezone,
      serviceTitle: booking.facilitator_services?.title ?? 'Session',
      startsAt: booking.starts_at,
    },
  });

  return ok({ message });
}

async function bookings(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  event: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const bookingId = event.pathParameters?.bookingId;

  if (!bookingId) {
    if (method === 'POST') return await createForClient(supabase, facilitator, event);
    if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
    const { data, error } = await supabase
      .from('bookings')
      .select(`${FACILITATOR_BOOKING_COLUMNS}, facilitator_services(title, duration_minutes, intake_questions)`)
      .eq('facilitator_id', facilitator.id)
      .neq('status', 'pending_payment')
      .order('starts_at', { ascending: false });
    if (error) throw error;
    return ok({ bookings: data ?? [], timezone: facilitator.timezone });
  }

  if (path.endsWith('/notes')) {
    if (method !== 'PUT') return badRequest(`Unsupported method ${method}`);
    return await saveSessionNotes(supabase, facilitator, bookingId, event);
  }

  // The message thread is the one per-booking route that is also a GET, so the
  // POST-only guard below sits after the booking is loaded rather than before.
  if (method !== 'POST' && !path.endsWith('/messages')) {
    return badRequest(`Unsupported method ${method}`);
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`${FACILITATOR_BOOKING_COLUMNS}, facilitator_services(title)`)
    .eq('id', bookingId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<any>();
  if (error) throw error;
  if (!booking) return notFound('Booking not found');

  if (path.endsWith('/messages')) {
    return await facilitatorMessages(supabase, facilitator, booking, method, event);
  }

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

  if (path.endsWith('/propose-time') || path.endsWith('/withdraw-proposal')) {
    return await proposeTime(supabase, facilitator, booking, event, path, now);
  }

  if (path.endsWith('/cancel')) {
    if (booking.status !== 'confirmed') return badRequest('Only a confirmed booking can be cancelled');

    // Always a full refund when the facilitator cancels, regardless of notice.
    const decision = refundForCancellation({
      priceCentavos: booking.price_centavos,
      startsAt: new Date(booking.starts_at),
      now,
      cancelledBy: 'facilitator',
      // Still a credit rather than a refund: the client has lost nothing they
      // paid for, and their package is whole again.
      fromPackage: Boolean(booking.package_id),
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
        proposed_starts_at: null,
        proposed_at: null,
        proposed_note: null,
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
        endsAt: booking.ends_at,
        bookingId,
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
      .select(
        'price_centavos, platform_fee_centavos, facilitator_net_centavos, status, booked_by, off_platform_centavos',
      )
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

  // Sessions the facilitator entered themselves carry zero everywhere the
  // payout arithmetic looks, on purpose (see 0031). Reported separately so
  // their own month still adds up — "6 sessions, ₱2,400 through Hilom" with
  // no mention of the two they arranged directly would look like a bug.
  const selfBooked = (monthRes.data ?? []).filter((row) => row.booked_by === 'facilitator');

  return ok({
    thisMonth: sum(monthRes.data),
    awaitingPayout: sum(unpaidRes.data),
    offPlatformThisMonth: {
      sessions: selfBooked.length,
      // Null (\"not recorded\") and 0 (\"nothing was charged\") both add nothing,
      // which is right: neither is money Hilom will ever pay out.
      centavos: selfBooked.reduce((total, row) => total + Number(row.off_platform_centavos ?? 0), 0),
    },
    platformFeeBps: facilitator.platform_fee_bps,
    payouts: payoutRes.data ?? [],
  });
}

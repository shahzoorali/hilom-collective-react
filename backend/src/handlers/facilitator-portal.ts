/**
 * The facilitator's own dashboard API.
 *
 *   GET    /facilitators/apply                     (any signed-in user)
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
 *   GET    /facilitator/events
 *   GET    /facilitator/events/{eventId}/roster
 *   PUT    /facilitator/events/{eventId}/join-link
 *   POST   /facilitator/events/{eventId}/send-join-details
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
import { cancelClassSession as cancelClassSessionShared } from '../lib/class-cancellation.js';
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
import { buildRoster, sendJoinDetailsToRegistrants } from '../lib/event-roster.js';
import { cancelEventDate } from '../lib/event-cancellation.js';
import { httpUrlOrNull, validateEvent } from '../lib/cms-events.js';
import { sendEventProposalSubmitted, sendEventEditSubmitted } from '../lib/booking-email.js';
import { selfActor, recordAudit } from '../lib/audit.js';
import { BlockValidationError } from '../lib/cms-blocks.js';
import { normalizeSlug, slugify, findAvailableFacilitatorSlug, SlugError } from '../lib/slug.js';
import { randomBytes } from 'node:crypto';

const OWN_COLUMNS =
  'id, slug, email, display_name, short_name, headline, bio, photo_media_id, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, website_url, years_experience, legal_name, phone, timezone, status, platform_fee_bps, vacation_until, payout_details, applied_at, approved_at';

interface FacilitatorRow {
  id: string;
  slug: string;
  email: string;
  display_name: string;
  timezone: string;
  status: string;
  platform_fee_bps: number;
}

export async function handler(ev: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = ev.requestContext.http.method;
  const path = ev.requestContext.http.path;

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
      const user = await requireUser(ev);
      if (method === 'GET') return await applicationStatus(user);
      return await apply(user, parseBody(ev));
    }

    const user = await requireGroup(ev, 'facilitator');
    const supabase = await getSupabase();
    const facilitator = await me(supabase, user);
    if (!facilitator) {
      // In the group but with no row: the group was granted without an
      // approved application. Fail closed rather than inventing a profile.
      return notFound('No facilitator profile is linked to this account');
    }

    if (path.endsWith('/facilitator/me')) {
      if (method === 'GET') return ok({ facilitator });
      if (method === 'PUT') return await updateProfile(supabase, facilitator, parseBody(ev));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/services')) {
      return await services(supabase, facilitator, ev, method);
    }

    if (path.endsWith('/facilitator/calendar-feed')) {
      return await calendarFeedToken(supabase, facilitator, method);
    }

    if (path.endsWith('/facilitator/slot-preview')) {
      if (method === 'GET') return await slotPreview(supabase, facilitator, ev);
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/availability')) {
      if (method === 'GET') return await listAvailability(supabase, facilitator);
      if (method === 'PUT') return await replaceAvailability(supabase, facilitator, parseBody(ev));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/blackouts')) {
      return await blackouts(supabase, facilitator, ev, method);
    }

    if (path.endsWith('/facilitator/messages')) {
      if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
      return await messageInbox(supabase, facilitator);
    }

    if (path.includes('/facilitator/clients')) {
      return await clients(supabase, facilitator, ev, method);
    }

    if (path.includes('/facilitator/bookings')) {
      return await bookings(supabase, facilitator, ev, method, path);
    }

    if (path.includes('/facilitator/classes')) {
      return await classes(supabase, facilitator, ev, method, path);
    }

    if (path.includes('/facilitator/event-series')) {
      return await eventSeries(supabase, facilitator, ev, method, path);
    }

    if (path.includes('/facilitator/events')) {
      return await events(supabase, facilitator, ev, method, path);
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
    if (err instanceof BlockValidationError) return badRequest(err.message);
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
 * The caller's own facilitator status, for any signed-in user.
 *
 * Every other read in this file sits behind the `facilitator` group, which is
 * exactly the population this one has to serve: an `applied` row has no group
 * yet, and neither does a `rejected` or `suspended` one. Without this the
 * dashboard could only distinguish "in the group" from "not", so someone three
 * days into review saw the same dead end as a stranger — and was invited to
 * apply again.
 *
 * Deliberately not the `me()` helper above: that one claims an unlinked row by
 * writing `cognito_sub`, and a status probe must not have side effects. The
 * email arm of the lookup still matters, because an admin-entered row has a
 * null `cognito_sub` until its owner's first portal call.
 *
 * Returns `status: null` rather than a 404 for "never applied" — that is a real
 * answer to this question, and the dashboard renders it as one more state.
 */
async function applicationStatus(user: {
  email: string;
  sub: string;
}): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('facilitators')
    .select('status, slug, display_name, applied_at, approved_at')
    .or(`cognito_sub.eq.${user.sub},email.eq.${user.email}`)
    .maybeSingle<{
      status: string;
      slug: string;
      display_name: string;
      applied_at: string | null;
      approved_at: string | null;
    }>();
  if (error) throw error;
  if (!data) return ok({ status: null });
  return ok(data);
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
      // No payment to wait for, but still inserted pending: confirmBooking()
      // below is what transitions the row *and* creates the meeting link and
      // emails both parties. Inserting 'confirmed' here made confirmBooking
      // early-return, so the client was never told they had a session.
      // hold_expires_at stays null so the sweep cannot reclaim it in the gap.
      status: 'pending_payment',
      hold_expires_at: null,
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
  /**
   * Confirmed registrations on events this facilitator hosts.
   *
   * Kept as its own count rather than folded into `sessions` because the two
   * are different relationships and get handled differently. Someone who has
   * had four 1:1s is a client; someone who came to one workshop is an
   * attendee, and a facilitator who messages the second as though they were
   * the first gets it wrong. The UI shows both numbers for that reason.
   */
  events: number;
  lastEventAt: string | null;
  nextEventAt: string | null;
}

/** Statuses that mean a session was real: held, or held and not attended. */
const DELIVERED = new Set(['confirmed', 'completed', 'no_show']);

/**
 * One row of the hosted-event roster query.
 *
 * `events` is singular in fact but PostgREST types an embedded relation as an
 * array when it cannot prove the FK is to-one; declared as the object it
 * actually is, because the query selects through a many-to-one FK.
 */
interface EventAttendeeRow {
  registrant_email: string;
  registrant_name: string | null;
  status: string;
  events: { id: string; starts_at: string; facilitator_id: string };
}

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
  const [bookingRes, aboutRes, eventRes] = await Promise.all([
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
    // Attendees of events this facilitator hosts (0045's facilitator_id).
    //
    // An inner join on the embedded event is what scopes this — PostgREST
    // returns a registration only when its event matches the filter, so a
    // facilitator can never see a roster that is not theirs. `!inner` is
    // load-bearing here, not a hint: without it the filter is applied to the
    // embedded row and every registration on the site comes back with a null
    // event attached.
    supabase
      .from('event_registrations')
      .select('registrant_email, registrant_name, status, events!inner(id, starts_at, facilitator_id)')
      .eq('events.facilitator_id', facilitator.id)
      .eq('status', 'confirmed')
      .limit(2000)
      .returns<EventAttendeeRow[]>(),
  ]);

  if (bookingRes.error) throw bookingRes.error;
  if (aboutRes.error) throw aboutRes.error;
  if (eventRes.error) throw eventRes.error;

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
        events: 0,
        lastEventAt: null,
        nextEventAt: null,
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

  // Event attendees are merged into the same map, so someone who both books
  // 1:1s and comes to workshops is one person with two histories rather than
  // two rows that happen to share an address. Keyed on the *registrant*, not
  // the buyer: when someone buys a place for a friend, the person in the room
  // is the one the facilitator will meet.
  for (const row of eventRes.data ?? []) {
    const email = String(row.registrant_email).toLowerCase();
    const startsAt = String(row.events.starts_at);
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
        events: 0,
        lastEventAt: null,
        nextEventAt: null,
      } satisfies ClientSummary);

    if (!current.name && row.registrant_name) current.name = String(row.registrant_name);

    current.events += 1;
    // This query is not ordered — the roster comes back however Postgres
    // returns it — so each side is a running min/max rather than relying on
    // first-seen the way the booking loop above does.
    if (isFuture) {
      if (!current.nextEventAt || startsAt < current.nextEventAt) current.nextEventAt = startsAt;
    } else if (!current.lastEventAt || startsAt > current.lastEventAt) {
      current.lastEventAt = startsAt;
    }

    byEmail.set(email, current);
  }

  // Someone with a session tomorrow is more interesting than someone last seen
  // in March, so upcoming sorts first; otherwise by recency. Events count as
  // engagements on both halves of that: an attendee arriving on Saturday
  // belongs at the top just as much as a 1:1 does.
  const soonest = (c: ClientSummary) =>
    [c.nextSessionAt, c.nextEventAt].filter(Boolean).sort()[0] ?? null;
  const latest = (c: ClientSummary) =>
    [c.lastSessionAt, c.lastEventAt].filter(Boolean).sort().reverse()[0] ?? '';

  const list = [...byEmail.values()].sort((a, b) => {
    const [an, bn] = [soonest(a), soonest(b)];
    if (an && bn) return an.localeCompare(bn);
    if (an) return -1;
    if (bn) return 1;
    return latest(b).localeCompare(latest(a));
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
  const [bookingRes, aboutRes, eventRes] = await Promise.all([
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
    // Their attendance at this facilitator's own events. Same `!inner` scoping
    // as the list above: the roster of an event someone else hosts is not
    // reachable through this endpoint.
    supabase
      .from('event_registrations')
      .select('id, status, registrant_name, events!inner(id, title, starts_at, ends_at, location, facilitator_id)')
      .eq('events.facilitator_id', facilitator.id)
      .ilike('registrant_email', clientEmail)
      .eq('status', 'confirmed')
      .order('id', { ascending: false }),
  ]);

  if (bookingRes.error) throw bookingRes.error;
  if (aboutRes.error) throw aboutRes.error;
  if (eventRes.error) throw eventRes.error;

  // `any[]` because the embedded relation defeats PostgREST's inferred row
  // type, exactly as it does on every other joined read in this file.
  const bookings = (bookingRes.data ?? []) as any[];
  const events = (eventRes.data ?? []) as any[];
  // Nobody by that address has ever booked with this facilitator *or* attended
  // one of their events. Not found rather than an empty timeline: an empty page
  // for an address they have never seen is a way to probe whether it exists.
  if (bookings.length === 0 && events.length === 0 && !aboutRes.data) {
    return notFound('No client by that address');
  }

  // Sorted here rather than in SQL: the order that matters is by event date,
  // which lives on the embedded row and is not something PostgREST will order
  // a parent query by.
  events.sort((a, b) => String(b.events?.starts_at ?? '').localeCompare(String(a.events?.starts_at ?? '')));

  return ok({
    email: clientEmail,
    name:
      bookings.find((row) => row.client_name)?.client_name ??
      events.find((row) => row.registrant_name)?.registrant_name ??
      null,
    about: aboutRes.data?.about ?? null,
    aboutUpdatedAt: aboutRes.data?.updated_at ?? null,
    bookings,
    events,
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
  //
  // "Seen" now means a booking *or* a place at one of their events — otherwise
  // the notes field is visible on an attendee's card and rejects every save.
  const [bookingCount, eventCount] = await Promise.all([
    supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('facilitator_id', facilitator.id)
      .ilike('client_email', clientEmail)
      .neq('status', 'pending_payment'),
    supabase
      .from('event_registrations')
      .select('id, events!inner(facilitator_id)', { count: 'exact', head: true })
      .eq('events.facilitator_id', facilitator.id)
      .ilike('registrant_email', clientEmail)
      .eq('status', 'confirmed'),
  ]);
  if (bookingCount.error) throw bookingCount.error;
  if (eventCount.error) throw eventCount.error;
  if (!bookingCount.count && !eventCount.count) return notFound('No client by that address');

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

  // prettier-ignore
  const [monthRes, unpaidRes, payoutRes, classMonthRes, classUnpaidRes, eventMonthRes, eventUnpaidRes] = await Promise.all([
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
    // Group class seats (0051). Counted on the same terms as bookings: this
    // month's classes, and everything delivered but not yet in a payout.
    //
    // Filtered on the session's date rather than the registration's, because
    // when the class happened is what decides the month it belongs to -- a
    // seat sold in March for an April class is April's earnings.
    supabase
      .from('class_registrations')
      .select(
        'price_centavos, platform_fee_centavos, facilitator_net_centavos, status, ' +
          'facilitator_class_sessions!inner(starts_at)',
      )
      .eq('facilitator_id', facilitator.id)
      .in('status', ['confirmed', 'completed'])
      .gte('facilitator_class_sessions.starts_at', monthStart)
      // The embedded relation defeats PostgREST's inferred row type.
      .returns<Record<string, unknown>[]>(),
    supabase
      .from('class_registrations')
      .select('price_centavos, platform_fee_centavos, facilitator_net_centavos')
      .eq('facilitator_id', facilitator.id)
      .eq('status', 'completed')
      .is('payout_id', null),
    // Event tickets they host (0054). The row is a paid charge, so an
    // instalment plan contributes the parts that have actually cleared.
    //
    // `facilitator_net_centavos is not null` is what separates an event with a
    // revenue share from one of Hilom's own, where the host earns nothing and
    // must not be shown a number as though they did.
    supabase
      .from('registration_charges')
      .select(
        'price_centavos:amount_centavos, platform_fee_centavos, facilitator_net_centavos, ' +
          'events!inner(facilitator_id, delivered_at)',
      )
      .eq('status', 'paid')
      .not('facilitator_net_centavos', 'is', null)
      .eq('events.facilitator_id', facilitator.id)
      .gte('events.delivered_at', monthStart)
      .returns<Record<string, unknown>[]>(),
    supabase
      .from('registration_charges')
      .select(
        'price_centavos:amount_centavos, platform_fee_centavos, facilitator_net_centavos, ' +
          'events!inner(facilitator_id)',
      )
      .eq('status', 'paid')
      .is('payout_id', null)
      .is('refunded_at', null)
      .not('facilitator_net_centavos', 'is', null)
      .eq('events.facilitator_id', facilitator.id)
      .returns<Record<string, unknown>[]>(),
  ]);

  if (monthRes.error) throw monthRes.error;
  if (unpaidRes.error) throw unpaidRes.error;
  if (payoutRes.error) throw payoutRes.error;
  if (classMonthRes.error) throw classMonthRes.error;
  if (classUnpaidRes.error) throw classUnpaidRes.error;
  if (eventMonthRes.error) throw eventMonthRes.error;
  if (eventUnpaidRes.error) throw eventUnpaidRes.error;

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

  // Bookings and class seats are added together, because a facilitator is one
  // person owed one sum and the payout batch totals them as one (0051). They
  // are also reported separately, so "why is this month bigger than my
  // sessions" has an answer on the screen rather than in a support thread.
  const classMonth = sum(classMonthRes.data);
  const classUnpaid = sum(classUnpaidRes.data);
  const bookingMonth = sum(monthRes.data);
  const bookingUnpaid = sum(unpaidRes.data);
  // `sessions` counts charges here, not tickets — one instalment plan is
  // several charges against one seat. It is reported as a money breakdown
  // rather than an attendance count, which is what the roster is for.
  const eventMonth = sum(eventMonthRes.data);
  const eventUnpaid = sum(eventUnpaidRes.data);

  const combine = (a: Totals, b: Totals): Totals => ({
    sessions: a.sessions + b.sessions,
    gross: a.gross + b.gross,
    fees: a.fees + b.fees,
    net: a.net + b.net,
  });

  return ok({
    thisMonth: combine(combine(bookingMonth, classMonth), eventMonth),
    awaitingPayout: combine(combine(bookingUnpaid, classUnpaid), eventUnpaid),
    // The class half on its own, for the breakdown line.
    classesThisMonth: classMonth,
    classesAwaitingPayout: classUnpaid,
    eventsThisMonth: eventMonth,
    eventsAwaitingPayout: eventUnpaid,
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

// ---------------------------------------------------------------------------
// Events this facilitator hosts
// ---------------------------------------------------------------------------

/**
 * The event columns the dashboard needs.
 *
 * `join_url` is here, unlike everywhere else it appears, because this is the
 * one read whose whole purpose is to let the host see and edit it. The
 * ownership check below is what makes that safe, and it is the same check every
 * other function in this file makes: scope by the facilitator row resolved from
 * the token, never by an id in the path.
 */
const HOSTED_EVENT_COLUMNS =
  // `description` is here for submitProposal, which refuses to submit without
  // one. Its absence made that check read `undefined` on every event and
  // reject every submission ever attempted, including events that had a
  // description saved — the facilitator saw their own text on screen and was
  // told to add it. Any column a guard reads has to be a column the read asks
  // for; nothing else in this file needs it.
  'id, title, subtitle, excerpt, description, image_url, image_alt, location, starts_at, ends_at, ' +
  'status, ticketing_enabled, capacity, currency, venue_details, format, join_url, join_instructions, ' +
  'review_status, submitted_at, reviewed_at, review_note, submitted_by, ' +
  // 0058. A pending edit to an already-approved event.
  'pending_changes, edit_submitted_at, edit_reviewed_at, edit_review_note';

/**
 * What a facilitator may write on their own event, and when.
 *
 * Three sets, because the answer changes twice as a proposal moves through
 * its life:
 *
 *   DRAFT_FIELDS    — the whole content. Editable while the row is theirs to
 *                      shape (draft or rejected) and frozen once submitted, so
 *                      that what an admin reviews cannot change underneath
 *                      them.
 *
 *   MATERIAL_FIELDS — the subset of DRAFT_FIELDS that is what someone
 *                      registered for: title, when, where, format. Once
 *                      approved, changing one of these does not write the
 *                      row — it stages a `pending_changes` edit for Hilom to
 *                      decide, and the *current* values keep showing on the
 *                      live, sold event until that decision lands. See 0058.
 *
 *   COSMETIC_FIELDS — DRAFT_FIELDS minus MATERIAL_FIELDS: subtitle, excerpt,
 *                      description, the image, practical details. None of
 *                      these change what somebody paid for, so once approved
 *                      they write straight onto the row — a typo fix or a
 *                      better poster image should not need Hilom's help.
 *
 *   HOST_FIELDS     — operational detail, editable at any point by the host,
 *                      approved or not. A corrected Zoom link two hours
 *                      before the doors open must not require an admin.
 *
 * Deliberately absent from all four: `status`, `review_status`, `capacity`,
 * `ticketing_enabled`, `currency` and anything on `event_payment_plans`. Those
 * are the money and the publish decision, and they belong to the admin — see
 * the check constraint in 0048, which is what actually enforces the publish
 * half of that.
 */
const DRAFT_FIELDS = [
  'title',
  'subtitle',
  'excerpt',
  'description',
  'image_url',
  'image_alt',
  'location',
  'starts_at',
  'ends_at',
  'venue_details',
  'format',
] as const;

const MATERIAL_FIELDS = ['title', 'starts_at', 'ends_at', 'location', 'format'] as const;
const COSMETIC_FIELDS = DRAFT_FIELDS.filter(
  (f) => !(MATERIAL_FIELDS as readonly string[]).includes(f),
) as Exclude<(typeof DRAFT_FIELDS)[number], (typeof MATERIAL_FIELDS)[number]>[];

const HOST_FIELDS = ['join_url', 'join_instructions'] as const;

/** Review states in which the proposal itself is still the facilitator's to edit. */
const EDITABLE_REVIEW_STATES = new Set(['draft', 'rejected']);

interface HostedEventRow extends Record<string, unknown> {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  join_url: string | null;
  join_instructions: string | null;
}

/**
 * Loads one event, but only if this facilitator hosts it.
 *
 * Returns null for "no such event" and for "not yours" alike — deliberately
 * indistinguishable, the same choice event-registrations.ts makes for a
 * registration belonging to someone else. A 403 on the second case would turn
 * this endpoint into a way to enumerate which event ids exist.
 */
async function ownedEvent(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
): Promise<HostedEventRow | null> {
  const { data, error } = await supabase
    .from('events')
    .select(HOSTED_EVENT_COLUMNS)
    .eq('id', eventId)
    // Theirs if they host it *or* proposed it. A submission that has not been
    // approved yet has no host assigned, so `facilitator_id` alone would lock
    // an author out of the row they just wrote.
    .or(`facilitator_id.eq.${facilitator.id},submitted_by.eq.${facilitator.id}`)
    .maybeSingle<HostedEventRow>();
  if (error) throw error;
  return data ?? null;
}

async function events(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  ev: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const eventId = ev.pathParameters?.eventId;

  if (!eventId) {
    if (method === 'GET') return await listHostedEvents(supabase, facilitator);
    if (method === 'POST') return await createProposal(supabase, facilitator, parseBody(ev));
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PUT' && path.endsWith('/submit')) {
    return await submitProposal(supabase, facilitator, eventId);
  }
  if (method === 'POST' && path.endsWith('/cancel')) {
    return await cancelHostedEvent(supabase, facilitator, eventId, parseBody(ev));
  }
  if (method === 'PUT' && !path.endsWith('/join-link')) {
    return await saveProposal(supabase, facilitator, eventId, parseBody(ev));
  }
  if (method === 'GET' && path.endsWith('/roster')) {
    return await hostedRoster(supabase, facilitator, eventId);
  }
  if (method === 'PUT' && path.endsWith('/join-link')) {
    return await saveJoinLink(supabase, facilitator, eventId, parseBody(ev));
  }
  if (method === 'POST' && path.endsWith('/send-join-details')) {
    return await resendJoinDetails(supabase, facilitator, eventId);
  }
  return badRequest(`Unsupported route ${method} ${path}`);
}

/**
 * Every event this facilitator hosts, with a live head count.
 *
 * Drafts included: a host configuring their joining link before the event is
 * published is exactly the case this was built for, and hiding unpublished
 * events from the person running them would be a strange kind of secrecy.
 */
async function listHostedEvents(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('events')
    .select(HOSTED_EVENT_COLUMNS)
    .or(`facilitator_id.eq.${facilitator.id},submitted_by.eq.${facilitator.id}`)
    .order('starts_at', { ascending: false })
    .returns<HostedEventRow[]>();
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return ok({ events: [] });

  // One count query across every event rather than one per event: the list is
  // small, but a per-row query here is the shape that quietly becomes N+1 once
  // somebody hosts twenty things.
  const { data: registrations, error: countError } = await supabase
    .from('event_registrations')
    .select('event_id, status')
    .in('event_id', rows.map((r) => r.id))
    .returns<{ event_id: string; status: string }[]>();
  if (countError) throw countError;

  const counts = new Map<string, { confirmed: number; pending: number }>();
  for (const r of registrations ?? []) {
    const c = counts.get(r.event_id) ?? { confirmed: 0, pending: 0 };
    if (r.status === 'confirmed' || r.status === 'completed') c.confirmed += 1;
    else if (r.status === 'pending_payment') c.pending += 1;
    counts.set(r.event_id, c);
  }

  return ok({
    events: rows.map((r) => ({
      ...r,
      registrations: counts.get(r.id) ?? { confirmed: 0, pending: 0 },
    })),
  });
}

/** The same roster the admin screen shows, for an event this facilitator hosts. */
async function hostedRoster(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
): Promise<APIGatewayProxyResultV2> {
  const hosted = await ownedEvent(supabase, facilitator, eventId);
  if (!hosted) return notFound('Event not found');

  const built = await buildRoster(supabase, eventId);
  if (!built) return notFound('Event not found');

  // The joining link travels with the roster so the tab can show it, edit it
  // and re-send it without a second round trip.
  return ok({
    ...built,
    joinLink: {
      join_url: hosted.join_url,
      join_instructions: hosted.join_instructions,
    },
  });
}

/**
 * The host sets or changes the joining link.
 *
 * Does **not** send anything by itself. Saving a link and telling 40 people
 * about it are different decisions — a host fixing a typo in the dial-in note
 * should not trigger 40 emails — so the send is its own explicit action below.
 */
async function saveJoinLink(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const hosted = await ownedEvent(supabase, facilitator, eventId);
  if (!hosted) return notFound('Event not found');

  const joinUrl = httpUrlOrNull(body.join_url, 'join_url');
  const instructions =
    body.join_instructions === undefined || body.join_instructions === null
      ? null
      : String(body.join_instructions).trim().slice(0, 1000) || null;

  const { data, error } = await supabase
    .from('events')
    .update({ join_url: joinUrl, join_instructions: instructions })
    .eq('id', eventId)
    // Repeated in the UPDATE and not merely relied on from the SELECT above:
    // the check and the write are two statements, and the one that matters for
    // safety is the one that writes.
    .eq('facilitator_id', facilitator.id)
    .select('id, join_url, join_instructions')
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');

  return ok({ joinLink: data, changed: joinUrl !== hosted.join_url });
}

/**
 * Sends the joining details to everyone holding a confirmed place.
 *
 * The rule for who gets told, and which of the two wordings they get, lives in
 * lib/event-roster.ts and is shared with admin — see the note there. This
 * function is the ownership check and nothing else.
 */
async function resendJoinDetails(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
): Promise<APIGatewayProxyResultV2> {
  const hosted = await ownedEvent(supabase, facilitator, eventId);
  if (!hosted) return notFound('Event not found');
  if (!hosted.join_url) return badRequest('Set a joining link before sending it out');

  const result = await sendJoinDetailsToRegistrants(supabase, {
    ...hosted,
    id: eventId,
  });
  return ok(result);
}

/**
 * The host calls off one date (0054, step 3).
 *
 * `ownedEvent` above is only the read-side check (host *or* proposer, for the
 * reason its own comment gives); the write in `cancelEventDate` re-asserts
 * `facilitator_id = this facilitator` itself, which is what actually stops one
 * facilitator cancelling another's date — `ownedEvent`'s `submitted_by` half
 * exists for editing a proposal still in review, not for an approved, hosted
 * event, and an admin may reassign the host on approval (see the note on
 * `submitted_by` in 0048).
 */
async function cancelHostedEvent(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const hosted = await ownedEvent(supabase, facilitator, eventId);
  if (!hosted) return notFound('Event not found');

  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!reason) return badRequest('Say why this date is being cancelled — registrants see this.');

  const result = await cancelEventDate(supabase, facilitator.id, eventId, reason, 'facilitator');
  if (!result) return notFound('Event not found, or already cancelled');

  return ok(result);
}

// ---------------------------------------------------------------------------
// Event proposals (0048)
// ---------------------------------------------------------------------------
//
//   POST /facilitator/events              — start a proposal
//   PUT  /facilitator/events/{id}         — save it, or edit the host fields
//   PUT  /facilitator/events/{id}/submit  — hand it to Hilom for review
//
// Nothing here can publish. `status` is never written by this file, and the
// check constraint in 0048 means even a bug that tried would be rejected by
// the database rather than by a code review.

/**
 * Runs the admin event validator, then keeps only the fields a facilitator is
 * allowed to set.
 *
 * Reusing `validateEvent` rather than writing a second validator is the point:
 * title limits, date ordering, rich-text sanitisation and the media-ref shape
 * are one implementation, so a rule tightened for admins is tightened here
 * too. The allowlist is applied *after* validation, so a body that smuggles
 * `capacity` or `link_url` is not rejected — it is silently dropped, which is
 * the right behaviour for a form that may legitimately post extra keys.
 */
function proposalFields(body: Record<string, unknown>): Record<string, unknown> {
  const validated = validateEvent(body) as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of DRAFT_FIELDS) {
    if (field in validated) picked[field] = validated[field];
  }
  return picked;
}

/** The operational fields, editable by the host whatever the review state. */
function hostFields(body: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of HOST_FIELDS) {
    if (field in body) {
      const value = body[field];
      picked[field] = typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
    }
  }
  return picked;
}

/**
 * A new proposal, always as a draft.
 *
 * `status: 'draft'` and `review_status: 'draft'` are written explicitly rather
 * than left to the column defaults, because 0048 defaults `review_status` to
 * 'approved' for the benefit of the rows that already existed. Relying on a
 * default here would publish-approve every facilitator submission on creation.
 */
async function createProposal(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  // Only a listed facilitator may propose. An applicant whose profile is still
  // in review has no standing to put an event on the public calendar, and
  // `status` here is the same gate the directory uses.
  if (facilitator.status !== 'published') {
    return badRequest('Your profile needs to be published before you can propose an event.');
  }

  const { data, error } = await supabase
    .from('events')
    .insert({
      ...proposalFields(body),
      ...hostFields(body),
      status: 'draft',
      review_status: 'draft',
      submitted_by: facilitator.id,
      // Proposed by them, so hosted by them unless an admin says otherwise.
      facilitator_id: facilitator.id,
    })
    .select(HOSTED_EVENT_COLUMNS)
    .single<HostedEventRow>();
  if (error) throw error;

  return ok({ event: data });
}

/**
 * Saves an edit.
 *
 * Which fields are accepted, and what happens to them, depends on where the
 * row is:
 *
 *   draft / rejected → the whole proposal plus the host fields, written
 *                       straight onto the row — nothing is live yet, so
 *                       there is nothing to protect.
 *   submitted        → host fields only; the proposal is frozen under review
 *                       so what an admin is looking at cannot change under
 *                       them.
 *   approved         → host fields and COSMETIC_FIELDS write straight onto
 *                       the row. Any MATERIAL_FIELDS that actually changed
 *                       are staged as `pending_changes` (0058) instead of
 *                       written — the live, sold event keeps its current
 *                       values until an admin decides — and Hilom is
 *                       alerted. Refused outright if an edit is already
 *                       awaiting a decision, so a second attempt cannot
 *                       silently overwrite the first admins haven't seen yet.
 *
 * An edit to a rejected *proposal* moves it back to 'draft' so it leaves the
 * admin's queue until it is resubmitted — unrelated to `pending_changes`,
 * which is a rejection of an *edit to an approved event* and never touches
 * `review_status` at all (see the note on 0058's columns).
 */
async function saveProposal(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const existing = await ownedEvent(supabase, facilitator, eventId);
  if (!existing) return notFound('Event not found');

  const reviewStatus = String(existing.review_status ?? 'approved');
  const editable = EDITABLE_REVIEW_STATES.has(reviewStatus);

  const patch: Record<string, unknown> = { ...hostFields(body) };
  let editSubmitted: string[] | null = null;

  if (editable) {
    Object.assign(patch, proposalFields(body));
    if (reviewStatus === 'rejected') {
      patch.review_status = 'draft';
      patch.review_note = null;
    }
  } else if (reviewStatus === 'approved') {
    const content = proposalFields(body);
    const material = (MATERIAL_FIELDS as readonly string[]).filter((f) => f in content);
    // Changed against the *live* row, not merely present in the body — the
    // form resends every field on every save, and resaving unchanged values
    // must not open a review.
    const changed = material.filter((f) => JSON.stringify(existing[f]) !== JSON.stringify(content[f]));

    for (const field of COSMETIC_FIELDS) {
      if (field in content) patch[field] = content[field];
    }

    if (changed.length > 0) {
      if (existing.pending_changes) {
        return badRequest(
          'A change to this event is already waiting on Hilom. Wait for that decision before proposing another.',
        );
      }
      patch.pending_changes = Object.fromEntries(changed.map((f) => [f, content[f]]));
      patch.edit_submitted_at = new Date().toISOString();
      patch.edit_reviewed_at = null;
      patch.edit_review_note = null;
      editSubmitted = changed;
    }
  }

  if (Object.keys(patch).length === 0) {
    return badRequest('Nothing to save. This event is being reviewed by Hilom.');
  }

  const { data, error } = await supabase
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .select(HOSTED_EVENT_COLUMNS)
    .single<HostedEventRow>();
  if (error) throw error;

  if (editSubmitted) {
    await sendEventEditSubmitted({
      facilitatorName: facilitator.display_name,
      eventTitle: existing.title,
      changedFields: editSubmitted,
    }).catch((err: unknown) => {
      console.error('[facilitatorPortal.saveProposal] edit-review alert failed', { eventId, err });
    });
  }

  return ok({ event: data });
}

/**
 * Hands a proposal to Hilom.
 *
 * Only from 'draft'. Submitting an already-submitted event would reset its
 * place in the queue, and submitting an approved one would un-publish an event
 * that may already have registrations against it — so both are refused here
 * rather than being allowed to fall through to a no-op that looks like success.
 */
async function submitProposal(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  eventId: string,
): Promise<APIGatewayProxyResultV2> {
  const existing = await ownedEvent(supabase, facilitator, eventId);
  if (!existing) return notFound('Event not found');

  const reviewStatus = String(existing.review_status ?? 'approved');
  if (reviewStatus === 'submitted') return badRequest('This is already with Hilom for review.');
  if (reviewStatus === 'approved') return badRequest('This event has already been approved.');

  // The things an admin cannot review the absence of. Checked at submit rather
  // than at save, so a half-written draft can still be saved and come back to.
  const missing = [
    !existing.title && 'a title',
    !existing.starts_at && 'a date',
    !existing.description && 'a description',
  ].filter((m): m is string => typeof m === 'string');
  if (missing.length > 0) {
    return badRequest(`Add ${missing.join(', ')} before submitting.`);
  }

  const { data, error } = await supabase
    .from('events')
    .update({
      review_status: 'submitted',
      submitted_at: new Date().toISOString(),
      review_note: null,
    })
    .eq('id', eventId)
    .select(HOSTED_EVENT_COLUMNS)
    .single<HostedEventRow>();
  if (error) throw error;

  return ok({ event: data });
}

// ---------------------------------------------------------------------------
// Event series (0054) — a multi-date proposal, reviewed once
// ---------------------------------------------------------------------------
//
//   GET  /facilitator/event-series                 — every series they proposed
//   POST /facilitator/event-series                 — start one, with its dates
//   GET  /facilitator/event-series/{id}             — one series and its dates
//   PUT  /facilitator/event-series/{id}             — edit content, price, capacity
//   PUT  /facilitator/event-series/{id}/dates       — replace the date list
//   PUT  /facilitator/event-series/{id}/submit      — hand it to Hilom for review
//
// Each date is still a plain `events` row (`series_id` points back here), so
// everything downstream of approval — seat claiming, checkout, fulfillment,
// the roster, cancelling one date — is the code that already exists for a
// single proposed event. This section only ever touches `event_series` and
// the *content* fields on its dates; ticketing, capacity and the revenue
// share are the admin's to set, at review, exactly as for a single event (see
// the comment on DRAFT_FIELDS) — see admin-registrations.ts `seriesReview`.

const SERIES_COLUMNS =
  'id, facilitator_id, title, review_status, submitted_at, reviewed_at, review_note, ' +
  'proposed_price_centavos, proposed_capacity, platform_fee_bps, created_at';

interface SeriesRow extends Record<string, unknown> {
  id: string;
  facilitator_id: string;
  title: string;
  review_status: string;
  proposed_price_centavos: number | null;
  proposed_capacity: number | null;
}

/** One proposed occurrence, before it becomes an `events` row. */
interface SeriesDate {
  starts_at: string;
  ends_at: string | null;
}

/**
 * Parses and orders the date list a series proposal carries.
 *
 * Capped at 30: this is a form for "Mon/Wed/Fri for a few weeks", not a
 * bulk-import tool, and an unbounded array here is an unbounded `events`
 * insert below.
 */
function seriesDates(body: Record<string, unknown>): SeriesDate[] {
  const raw = Array.isArray(body.dates) ? body.dates : [];
  if (raw.length === 0) throw new FacilitatorInputError('Add at least one date.');
  if (raw.length > 30) {
    throw new FacilitatorInputError('That is too many dates for one series — split it into more than one.');
  }

  return raw
    .map((item, i): SeriesDate => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const startsAt = new Date(String(rec.starts_at ?? ''));
      if (Number.isNaN(startsAt.getTime())) {
        throw new FacilitatorInputError(`Date ${i + 1} needs a valid start time.`);
      }
      let endsAt: Date | null = null;
      if (rec.ends_at) {
        endsAt = new Date(String(rec.ends_at));
        if (Number.isNaN(endsAt.getTime())) {
          throw new FacilitatorInputError(`Date ${i + 1} has an invalid end time.`);
        }
        if (endsAt < startsAt) throw new FacilitatorInputError(`Date ${i + 1} ends before it starts.`);
      }
      return { starts_at: startsAt.toISOString(), ends_at: endsAt ? endsAt.toISOString() : null };
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/**
 * The content shared by every date in a series, validated through the same
 * `validateEvent` a single proposal uses.
 *
 * `validateEvent` requires `starts_at`, which a series body carries per-date
 * rather than at the top level — so the first date is loaned to it here and
 * discarded from the result. Each date event gets its own `starts_at`/`ends_at`
 * from `seriesDates` above, never from this.
 */
function seriesContentFields(body: Record<string, unknown>, firstStartsAt: string): Record<string, unknown> {
  const validated = validateEvent({ ...body, starts_at: firstStartsAt }) as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of DRAFT_FIELDS) {
    if (field === 'starts_at' || field === 'ends_at') continue;
    if (field in validated) picked[field] = validated[field];
  }
  return picked;
}

/** The facilitator's proposed price and capacity — an ask, not a plan. See 0055. */
function proposedMoney(body: Record<string, unknown>): { price: number | null; capacity: number | null } {
  let price: number | null = null;
  if (body.proposed_price_centavos !== undefined && body.proposed_price_centavos !== null) {
    const n = Number(body.proposed_price_centavos);
    if (!Number.isInteger(n) || n < 0) throw new FacilitatorInputError('That price is not a whole number of centavos.');
    price = n;
  }
  let capacity: number | null = null;
  if (body.proposed_capacity !== undefined && body.proposed_capacity !== null) {
    const n = Number(body.proposed_capacity);
    if (!Number.isInteger(n) || n < 1) throw new FacilitatorInputError('Capacity must be a whole number of seats, at least 1.');
    capacity = n;
  }
  return { price, capacity };
}

/** Loads one series, but only if this facilitator proposed it. Same null-for-both-cases rule as `ownedEvent`. */
async function ownedSeries(supabase: SupabaseClient, facilitator: FacilitatorRow, seriesId: string): Promise<SeriesRow | null> {
  const { data, error } = await supabase
    .from('event_series')
    .select(SERIES_COLUMNS)
    .eq('id', seriesId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<SeriesRow>();
  if (error) throw error;
  return data ?? null;
}

async function eventSeries(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  ev: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const seriesId = ev.pathParameters?.seriesId;

  if (!seriesId) {
    if (method === 'GET') return await listSeries(supabase, facilitator);
    if (method === 'POST') return await createSeries(supabase, facilitator, parseBody(ev));
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PUT' && path.endsWith('/submit')) {
    return await submitSeries(supabase, facilitator, ev, seriesId);
  }
  if (method === 'PUT' && path.endsWith('/dates')) {
    return await replaceSeriesDates(supabase, facilitator, seriesId, parseBody(ev));
  }
  if (method === 'GET') return await getSeries(supabase, facilitator, seriesId);
  if (method === 'PUT') return await updateSeries(supabase, facilitator, seriesId, parseBody(ev));
  return badRequest(`Unsupported route ${method} ${path}`);
}

async function listSeries(supabase: SupabaseClient, facilitator: FacilitatorRow): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('event_series')
    .select(SERIES_COLUMNS)
    .eq('facilitator_id', facilitator.id)
    .order('created_at', { ascending: false })
    .returns<SeriesRow[]>();
  if (error) throw error;

  const series = data ?? [];
  if (series.length === 0) return ok({ series: [] });

  const { data: dates, error: datesError } = await supabase
    .from('events')
    .select('id, series_id, starts_at, ends_at, status')
    .in('series_id', series.map((s) => s.id))
    .order('starts_at', { ascending: true })
    .returns<{ id: string; series_id: string; starts_at: string; ends_at: string | null; status: string }[]>();
  if (datesError) throw datesError;

  const byseries = new Map<string, typeof dates>();
  for (const d of dates ?? []) {
    const list = byseries.get(d.series_id) ?? [];
    list.push(d);
    byseries.set(d.series_id, list);
  }

  return ok({ series: series.map((s) => ({ ...s, dates: byseries.get(s.id) ?? [] })) });
}

async function getSeries(supabase: SupabaseClient, facilitator: FacilitatorRow, seriesId: string): Promise<APIGatewayProxyResultV2> {
  const series = await ownedSeries(supabase, facilitator, seriesId);
  if (!series) return notFound('Series not found');

  const { data: dates, error } = await supabase
    .from('events')
    .select(HOSTED_EVENT_COLUMNS)
    .eq('series_id', seriesId)
    .order('starts_at', { ascending: true })
    .returns<HostedEventRow[]>();
  if (error) throw error;

  return ok({ series, dates: dates ?? [] });
}

/**
 * A new series: the row that gets reviewed, plus one `events` row per date.
 *
 * `title` is read back off the validated content rather than the raw body,
 * for the same sanitisation `validateEvent` already gives a single proposal.
 */
async function createSeries(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  if (facilitator.status !== 'published') {
    return badRequest('Your profile needs to be published before you can propose an event.');
  }

  const dates = seriesDates(body);
  const firstDate = dates[0];
  if (!firstDate) throw new FacilitatorInputError('Add at least one date.');
  const content = seriesContentFields(body, firstDate.starts_at);
  const { price, capacity } = proposedMoney(body);

  const { data: series, error: seriesError } = await supabase
    .from('event_series')
    .insert({
      facilitator_id: facilitator.id,
      title: content.title as string,
      proposed_price_centavos: price,
      proposed_capacity: capacity,
    })
    .select(SERIES_COLUMNS)
    .single<SeriesRow>();
  if (seriesError) throw seriesError;

  const rows = dates.map((d) => ({
    ...content,
    ...d,
    status: 'draft',
    review_status: 'draft',
    submitted_by: facilitator.id,
    facilitator_id: facilitator.id,
    series_id: series.id,
  }));

  const { data: events, error: eventsError } = await supabase
    .from('events')
    .insert(rows)
    .select(HOSTED_EVENT_COLUMNS)
    .returns<HostedEventRow[]>();
  if (eventsError) throw eventsError;

  return ok({ series, dates: events ?? [] });
}

/**
 * Edits a series' shared content, and its proposed price and capacity.
 *
 * Only while the series is still the facilitator's to shape (draft or
 * rejected) — the same `EDITABLE_REVIEW_STATES` rule a single proposal
 * follows, and for the same reason: what an admin is reviewing, or has
 * approved, cannot change underneath them.
 *
 * Editing a rejected series returns it to draft, on the series and on every
 * one of its dates — the individual `events.review_status` is what the
 * publish constraint (0048) actually checks, so it has to move in step with
 * the series or a date could be left claiming a review that no longer applies.
 */
async function updateSeries(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  seriesId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const series = await ownedSeries(supabase, facilitator, seriesId);
  if (!series) return notFound('Series not found');
  if (!EDITABLE_REVIEW_STATES.has(series.review_status)) {
    return badRequest('This series is being reviewed by Hilom, or has already been approved.');
  }

  const { data: firstDate, error: firstError } = await supabase
    .from('events')
    .select('starts_at')
    .eq('series_id', seriesId)
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ starts_at: string }>();
  if (firstError) throw firstError;
  if (!firstDate) return notFound('Series not found');

  const content = seriesContentFields(body, firstDate.starts_at);
  const { price, capacity } = proposedMoney(body);

  const seriesPatch: Record<string, unknown> = { title: content.title };
  if (body.proposed_price_centavos !== undefined) seriesPatch.proposed_price_centavos = price;
  if (body.proposed_capacity !== undefined) seriesPatch.proposed_capacity = capacity;

  const eventsPatch: Record<string, unknown> = { ...content };
  if (series.review_status === 'rejected') {
    seriesPatch.review_status = 'draft';
    seriesPatch.review_note = null;
    eventsPatch.review_status = 'draft';
    eventsPatch.review_note = null;
  }

  const { data: updatedSeries, error: seriesError } = await supabase
    .from('event_series')
    .update(seriesPatch)
    .eq('id', seriesId)
    .select(SERIES_COLUMNS)
    .single<SeriesRow>();
  if (seriesError) throw seriesError;

  const { data: dates, error: datesError } = await supabase
    .from('events')
    .update(eventsPatch)
    .eq('series_id', seriesId)
    .select(HOSTED_EVENT_COLUMNS)
    .returns<HostedEventRow[]>();
  if (datesError) throw datesError;

  return ok({ series: updatedSeries, dates: dates ?? [] });
}

/**
 * Replaces a series' date list wholesale.
 *
 * Safe to do destructively — delete every current date and insert the new
 * set — only because this is reachable exclusively while the series is draft
 * or rejected (see `updateSeries`), which means none of its dates can have
 * been published or hold a registration yet. Reusing `content` read off the
 * first surviving date is what keeps the title, description and every other
 * shared field from having to be resent just to add a fourth Wednesday.
 */
async function replaceSeriesDates(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  seriesId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const series = await ownedSeries(supabase, facilitator, seriesId);
  if (!series) return notFound('Series not found');
  if (!EDITABLE_REVIEW_STATES.has(series.review_status)) {
    return badRequest('This series is being reviewed by Hilom, or has already been approved.');
  }

  const { data: template, error: templateError } = await supabase
    .from('events')
    .select(HOSTED_EVENT_COLUMNS)
    .eq('series_id', seriesId)
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle<HostedEventRow>();
  if (templateError) throw templateError;
  if (!template) return notFound('Series not found');

  const dates = seriesDates(body);
  const content: Record<string, unknown> = {};
  for (const field of DRAFT_FIELDS) {
    if (field === 'starts_at' || field === 'ends_at') continue;
    content[field] = (template as unknown as Record<string, unknown>)[field];
  }

  const { error: deleteError } = await supabase.from('events').delete().eq('series_id', seriesId);
  if (deleteError) throw deleteError;

  const rows = dates.map((d) => ({
    ...content,
    ...d,
    status: 'draft',
    review_status: 'draft',
    submitted_by: facilitator.id,
    facilitator_id: facilitator.id,
    series_id: seriesId,
  }));

  const { data: events, error: insertError } = await supabase
    .from('events')
    .insert(rows)
    .select(HOSTED_EVENT_COLUMNS)
    .returns<HostedEventRow[]>();
  if (insertError) throw insertError;

  return ok({ series, dates: events ?? [] });
}

/**
 * Hands a series to Hilom, mirroring `submitProposal` at the series level.
 *
 * Both the series and every one of its dates move to 'submitted' in the same
 * request — the dates' own `review_status` is what actually gates publishing
 * (0048's check constraint reads the event row, not the series), so it has to
 * track the series' decision rather than lag behind it.
 */
async function submitSeries(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  ev: APIGatewayProxyEventV2,
  seriesId: string,
): Promise<APIGatewayProxyResultV2> {
  const series = await ownedSeries(supabase, facilitator, seriesId);
  if (!series) return notFound('Series not found');
  if (series.review_status === 'submitted') return badRequest('This is already with Hilom for review.');
  if (series.review_status === 'approved') return badRequest('This series has already been approved.');

  const { data: dates, error: datesError } = await supabase
    .from('events')
    .select('id, starts_at, description')
    .eq('series_id', seriesId)
    .order('starts_at', { ascending: true })
    .returns<{ id: string; starts_at: string; description: string | null }[]>();
  if (datesError) throw datesError;
  const firstDate = dates?.[0];
  if (!dates || dates.length === 0 || !firstDate) return badRequest('Add at least one date before submitting.');
  if (!firstDate.description) return badRequest('Add a description before submitting.');

  const now = new Date().toISOString();

  const { data: updatedSeries, error: seriesError } = await supabase
    .from('event_series')
    .update({ review_status: 'submitted', submitted_at: now, review_note: null })
    .eq('id', seriesId)
    .select(SERIES_COLUMNS)
    .single<SeriesRow>();
  if (seriesError) throw seriesError;

  const { error: eventsError } = await supabase
    .from('events')
    .update({ review_status: 'submitted', submitted_at: now, review_note: null })
    .eq('series_id', seriesId);
  if (eventsError) throw eventsError;

  await sendEventProposalSubmitted({
    facilitatorName: facilitator.display_name,
    seriesTitle: series.title,
    dateCount: dates.length,
    firstDate: firstDate.starts_at,
    proposedPriceCentavos: series.proposed_price_centavos,
    timezone: facilitator.timezone,
  }).catch((err: unknown) => {
    console.error('[facilitatorPortal.submitSeries] admin alert failed', { seriesId, err });
  });

  await recordAudit(selfActor(facilitator.email, ev), {
    action: 'event_series.submitted',
    targetTable: 'event_series',
    targetId: seriesId,
    note: `"${series.title}" submitted with ${dates.length} date${dates.length === 1 ? '' : 's'}`,
  });

  return ok({ series: updatedSeries });
}

// ---------------------------------------------------------------------------
// Group classes (0049) — the facilitator's own half
// ---------------------------------------------------------------------------
//
//   GET    /facilitator/classes                        — what they teach
//   POST   /facilitator/classes                        — a new class
//   PUT    /facilitator/classes/{classId}              — edit it
//   DELETE /facilitator/classes/{classId}              — deactivate it
//   POST   /facilitator/classes/{classId}/sessions     — schedule an occurrence
//   GET    /facilitator/classes/{classId}/sessions     — its occurrences + rosters
//   DELETE /facilitator/classes/sessions/{sessionId}   — cancel one occurrence
//   PUT    /facilitator/classes/sessions/{sessionId}   — correct a session's price
//
// A class is never deleted, only deactivated, for the reason the FK says: its
// sessions carry seats people paid for.


/** What a facilitator may set on a class. Everything else is derived. */
function classInput(body: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown, max: number): string | null => {
    const s = typeof value === 'string' ? value.trim() : '';
    return s ? s.slice(0, max) : null;
  };

  const title = text(body.title, 200);
  if (!title) throw new FacilitatorInputError('A class needs a title.');

  const duration = Number(body.duration_minutes ?? 0);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
    throw new FacilitatorInputError('Length must be between 5 and 480 minutes.');
  }

  const price = Number(body.price_centavos ?? 0);
  if (!Number.isInteger(price) || price < 0) {
    throw new FacilitatorInputError('That price is not a number of centavos.');
  }

  const minJoiners = Number(body.min_joiners ?? 1);
  const maxJoiners = Number(body.max_joiners ?? 0);
  if (!Number.isInteger(minJoiners) || minJoiners < 1) {
    throw new FacilitatorInputError('The minimum must be at least 1.');
  }
  if (!Number.isInteger(maxJoiners) || maxJoiners < 1) {
    throw new FacilitatorInputError('Set how many people can join.');
  }
  // Checked here as well as by the constraint so the message is a sentence
  // rather than a Postgres constraint name.
  if (maxJoiners < minJoiners) {
    throw new FacilitatorInputError('The maximum cannot be lower than the minimum.');
  }

  const mode = String(body.delivery_mode ?? 'online');
  if (!['online', 'in_person', 'both'].includes(mode)) {
    throw new FacilitatorInputError('Pick online, in person, or both.');
  }

  return {
    title,
    description: text(body.description, 5000),
    delivery_mode: mode,
    location: text(body.location, 300),
    meeting_url: httpUrlOrNull(body.meeting_url, 'meeting_url'),
    duration_minutes: duration,
    price_centavos: price,
    min_joiners: minJoiners,
    max_joiners: maxJoiners,
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
  };
}

async function classes(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  ev: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<APIGatewayProxyResultV2> {
  const classId = ev.pathParameters?.classId;
  const sessionId = ev.pathParameters?.sessionId;

  if (sessionId) {
    if (method === 'DELETE') return await cancelClassSession(supabase, facilitator, sessionId, ev);
    if (method === 'PUT') return await updateClassSessionPrice(supabase, facilitator, sessionId, parseBody(ev));
    return badRequest(`Unsupported method ${method}`);
  }

  if (!classId) {
    if (method === 'GET') return await listClasses(supabase, facilitator);
    if (method === 'POST') return await createClass(supabase, facilitator, parseBody(ev));
    return badRequest(`Unsupported method ${method}`);
  }

  if (path.endsWith('/sessions')) {
    if (method === 'GET') return await listClassSessions(supabase, facilitator, classId);
    if (method === 'POST') {
      return await scheduleClassSession(supabase, facilitator, classId, parseBody(ev));
    }
    return badRequest(`Unsupported method ${method}`);
  }

  if (method === 'PUT') return await updateClass(supabase, facilitator, classId, parseBody(ev));
  if (method === 'DELETE') return await deactivateClass(supabase, facilitator, classId);
  return badRequest(`Unsupported method ${method}`);
}

/** Their classes, including deactivated ones — this is the management screen. */
async function listClasses(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_classes')
    .select('*')
    .eq('facilitator_id', facilitator.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ok({ classes: data ?? [] });
}

async function createClass(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_classes')
    .insert({ ...classInput(body), facilitator_id: facilitator.id })
    .select('*')
    .single();
  if (error) throw error;
  return ok({ class: data });
}

/**
 * Edits a class.
 *
 * Note what this does *not* touch: the sessions already on the calendar. Price,
 * capacity and the meeting link are snapshotted onto a session when it is
 * scheduled, precisely so that editing the class in November cannot restate
 * what somebody bought in September. New sessions pick up the new values.
 */
async function updateClass(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  classId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_classes')
    .update(classInput(body))
    .eq('id', classId)
    .eq('facilitator_id', facilitator.id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Class not found');
  return ok({ class: data });
}

/**
 * Takes a class off sale.
 *
 * Deactivated, never deleted: the FK from sessions is ON DELETE RESTRICT
 * because those sessions carry seats people paid for. Scheduled sessions are
 * deliberately left alone — a facilitator who stops offering a class still has
 * to teach the ones already sold, and silently cancelling them here would
 * strand paying clients with no notice and no refund.
 */
async function deactivateClass(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  classId: string,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_classes')
    .update({ is_active: false })
    .eq('id', classId)
    .eq('facilitator_id', facilitator.id)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  if (!data) return notFound('Class not found');

  const { count } = await supabase
    .from('facilitator_class_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('class_id', classId)
    .eq('status', 'scheduled')
    .gt('starts_at', new Date().toISOString());

  return ok({ deactivated: true, upcomingSessions: count ?? 0 });
}

/**
 * Schedules one occurrence.
 *
 * The price, capacity, minimum and meeting link are copied from the class onto
 * the session here — the one moment they are read. From then on the session is
 * self-contained, which is what lets the class be edited without moving the
 * ground under sessions that have already sold.
 *
 * Overlap with the facilitator's own 1:1 diary is *not* checked. A class
 * session is added to `busy` in scheduling.ts, so it blocks future 1:1
 * bookings from the moment it exists; the reverse case — scheduling a class
 * over a session already in the diary — is a conflict the facilitator can see
 * on their own calendar and may legitimately intend while they move things
 * around. Refusing it would make the screen unusable for exactly the person
 * who knows best.
 */
async function scheduleClassSession(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  classId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const { data: cls, error: readError } = await supabase
    .from('facilitator_classes')
    .select('*')
    .eq('id', classId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<Record<string, any>>();
  if (readError) throw readError;
  if (!cls) return notFound('Class not found');

  const startsAt = typeof body.starts_at === 'string' ? new Date(body.starts_at) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) {
    throw new FacilitatorInputError('That start time is not a date.');
  }
  if (startsAt.getTime() <= Date.now()) {
    throw new FacilitatorInputError('A class cannot be scheduled in the past.');
  }

  const endsAt = new Date(startsAt.getTime() + Number(cls.duration_minutes) * 60_000);

  const { data, error } = await supabase
    .from('facilitator_class_sessions')
    .insert({
      class_id: classId,
      facilitator_id: facilitator.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      price_centavos: cls.price_centavos,
      currency: cls.currency,
      capacity: cls.max_joiners,
      min_joiners: cls.min_joiners,
      meeting_url: cls.meeting_url,
      status: 'scheduled',
    })
    .select('*')
    .single();
  if (error) throw error;

  return ok({ session: data });
}

/** Every occurrence of one class, with who is on it. */
async function listClassSessions(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  classId: string,
): Promise<APIGatewayProxyResultV2> {
  const { data: sessions, error } = await supabase
    .from('facilitator_class_sessions')
    .select('*')
    .eq('class_id', classId)
    .eq('facilitator_id', facilitator.id)
    .order('starts_at', { ascending: false })
    .returns<Record<string, any>[]>();
  if (error) throw error;

  const rows = sessions ?? [];
  if (rows.length === 0) return ok({ sessions: [] });

  const { data: registrations, error: regError } = await supabase
    .from('class_registrations')
    .select('id, session_id, client_email, client_name, client_notes, status, seat_no')
    .in('session_id', rows.map((s) => s.id as string))
    .in('status', ['pending_payment', 'confirmed', 'completed'])
    .order('seat_no', { ascending: true })
    .returns<Record<string, any>[]>();
  if (regError) throw regError;

  const bySession = new Map<string, Record<string, any>[]>();
  for (const r of registrations ?? []) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(r);
    bySession.set(r.session_id, list);
  }

  return ok({
    sessions: rows.map((s) => {
      const roster = bySession.get(s.id as string) ?? [];
      const paid = roster.filter((r) => r.status !== 'pending_payment');
      return {
        ...s,
        roster,
        seatsTaken: roster.length,
        // Surfaced so the screen can say "2 of 3 — runs anyway". Nothing acts
        // on it: the minimum is advisory (0049).
        meetsMinimum: paid.length >= Number(s.min_joiners),
      };
    }),
  });
}

/**
 * Cancels one occurrence.
 *
 * A thin wrapper: the actual cancellation lives in lib/class-cancellation.ts,
 * shared with the admin panel's Classes screen, so a facilitator's cancel and
 * an admin's cancel record identical refunds and send identical emails. See
 * that file's header for why this could not be two implementations.
 */
async function cancelClassSession(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  sessionId: string,
  ev: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(ev);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : null;

  const result = await cancelClassSessionShared(supabase, facilitator, sessionId, reason, 'facilitator');
  if (!result) return notFound('Session not found, or already cancelled');
  return ok(result);
}

/**
 * Corrects one scheduled session's price.
 *
 * A session snapshots the class's price at the moment it is scheduled, on
 * purpose (see the header on facilitator_class_sessions in 0049): editing a
 * class later must not move the ground under a date someone already paid
 * for. What that decision left with no answer is a session scheduled *before*
 * the class was priced correctly — Prem's "Online HIIT Pilates Express" sat
 * at price_centavos = 0 on every September date after he set the class to
 * ₱15, and nothing told him or a browsing client the two numbers had come
 * apart (docs/class-and-event-bugfixes-plan.md §3).
 *
 * Allowed only while `seatsTaken = 0` — the moment someone holds a seat, the
 * snapshot rule has to hold for them same as anyone who paid outright. This
 * mirrors the existing rule that a class's own description is only editable
 * while a proposal is a draft: editable until someone has acted on it.
 */
async function updateClassSessionPrice(
  supabase: SupabaseClient,
  facilitator: FacilitatorRow,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const price = Number(body.price_centavos);
  if (!Number.isInteger(price) || price < 0) {
    throw new FacilitatorInputError('That price is not a number of centavos.');
  }

  const { data: session, error } = await supabase
    .from('facilitator_class_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('facilitator_id', facilitator.id)
    .maybeSingle<{ id: string; status: string }>();
  if (error) throw error;
  if (!session) return notFound('Session not found');
  if (session.status !== 'scheduled') {
    return badRequest('Only a scheduled session can have its price corrected.');
  }

  const { count, error: seatError } = await supabase
    .from('class_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .in('status', ['pending_payment', 'confirmed']);
  if (seatError) throw seatError;
  if ((count ?? 0) > 0) {
    return badRequest(
      'This session already has someone in it — its price is locked in for them and cannot change.',
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from('facilitator_class_sessions')
    .update({ price_centavos: price })
    .eq('id', sessionId)
    .select('*')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) return notFound('Session not found');

  return ok({ session: updated });
}

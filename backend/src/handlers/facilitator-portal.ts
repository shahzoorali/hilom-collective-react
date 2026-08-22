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
import { ok, notFound, badRequest, unauthorized, serverError } from '../lib/http.js';
import { requireUser, requireGroup, UnauthorizedError } from '../lib/auth.js';
import { SERVICE_PUBLIC_COLUMNS } from '../lib/scheduling.js';
import { refundForCancellation } from '../lib/booking-domain.js';
import { sendBookingCancelled } from '../lib/booking-email.js';
import {
  validateProfile,
  validateService,
  validateAvailability,
  validateBlackout,
  FacilitatorInputError,
} from '../lib/facilitator-input.js';
import { normalizeSlug, slugify, findAvailableSlug, SlugError } from '../lib/slug.js';

const OWN_COLUMNS =
  'id, slug, email, display_name, headline, bio, photo_media_id, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, legal_name, phone, timezone, status, platform_fee_bps, vacation_until, payout_details, applied_at, approved_at';

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

  try {
    // The application endpoint is the one route open to any signed-in user —
    // by definition the applicant is not yet in the facilitator group.
    if (path.endsWith('/facilitators/apply')) {
      const user = await requireUser(event);
      return apply(user, parseBody(event));
    }

    const user = await requireGroup(event, 'facilitator');
    const supabase = await getSupabase();

    const { data: facilitator, error } = await supabase
      .from('facilitators')
      .select(OWN_COLUMNS)
      .eq('cognito_sub', user.sub)
      .maybeSingle<FacilitatorRow & Record<string, unknown>>();

    if (error) throw error;
    if (!facilitator) {
      // In the group but with no row: the group was granted without an
      // approved application. Fail closed rather than inventing a profile.
      return notFound('No facilitator profile is linked to this account');
    }

    if (path.endsWith('/facilitator/me')) {
      if (method === 'GET') return ok({ facilitator });
      if (method === 'PUT') return updateProfile(supabase, facilitator, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/services')) {
      return services(supabase, facilitator, event, method);
    }

    if (path.includes('/facilitator/availability')) {
      if (method === 'GET') return listAvailability(supabase, facilitator);
      if (method === 'PUT') return replaceAvailability(supabase, facilitator, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (path.includes('/facilitator/blackouts')) {
      return blackouts(supabase, facilitator, event, method);
    }

    if (path.includes('/facilitator/bookings')) {
      return bookings(supabase, facilitator, event, method, path);
    }

    if (path.endsWith('/facilitator/earnings')) {
      return earnings(supabase, facilitator);
    }

    return notFound();
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    if (err instanceof FacilitatorInputError) return badRequest(err.message);
    if (err instanceof SlugError) return badRequest(err.message);
    return serverError('facilitatorPortal', err);
  }
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
 * `platform_fee_bps` from the body. Everything an applicant can write here is
 * profile copy; status, fee rate and publication are admin decisions.
 */
async function apply(
  user: { email: string; sub: string; givenName?: string; familyName?: string },
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('facilitators')
    .select('id, status')
    .or(`cognito_sub.eq.${user.sub},email.eq.${user.email}`)
    .maybeSingle<{ id: string; status: string }>();
  if (existingError) throw existingError;
  if (existing) {
    return ok({ alreadyApplied: true, status: existing.status });
  }

  const profile = validateProfile({
    ...body,
    display_name:
      body.display_name ?? [user.givenName, user.familyName].filter(Boolean).join(' ') ?? user.email,
  });

  const base = slugify(profile.display_name) || 'facilitator';
  const slug = await findAvailableSlug(normalizeSlug(base), async (candidate) => {
    const { data } = await supabase.from('facilitators').select('id').eq('slug', candidate).maybeSingle();
    return Boolean(data);
  });

  const { data, error } = await supabase
    .from('facilitators')
    .insert({
      ...profile,
      slug,
      email: user.email,
      cognito_sub: user.sub,
      legal_name: typeof body.legal_name === 'string' ? body.legal_name.trim().slice(0, 160) : null,
      phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : null,
      status: 'applied',
    })
    .select('id, slug, status')
    .maybeSingle();

  if (error) throw error;
  return ok({ facilitator: data, status: 'applied' });
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
  return ok({ facilitator: data });
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
  'id, service_id, service_kind, client_email, client_name, client_notes, starts_at, ends_at, status, price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, meeting_url, cancelled_at, cancelled_by, cancellation_reason, refund_centavos, payout_id, created_at';

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
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'no_show' })
      .eq('id', bookingId)
      .eq('facilitator_id', facilitator.id);
    if (updateError) throw updateError;
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

    const { error: updateError } = await supabase
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
      .eq('status', 'confirmed');
    if (updateError) throw updateError;

    await sendBookingCancelled(
      {
        clientEmail: booking.client_email,
        clientName: booking.client_name,
        facilitatorEmail: facilitator.email,
        facilitatorName: facilitator.display_name,
        facilitatorTimezone: facilitator.timezone,
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

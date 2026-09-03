/**
 * Public facilitator directory.
 *
 *   GET /facilitators
 *   GET /facilitators/{slug}
 *   GET /facilitators/{slug}/availability?serviceId=&from=&to=
 *   GET /facilitator-calendar/{token}   — the subscribable .ics feed
 *
 * Every query filters `status = 'published'` explicitly. The RLS policy in
 * 0011_facilitators.sql says the same thing, but the backend connects with the
 * secret key, which bypasses RLS entirely — so RLS is the second layer here,
 * not the first. Forgetting the filter would expose applications and suspended
 * profiles, which is precisely what the approval workflow exists to prevent.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError, text } from '../lib/http.js';
import { renderCalendar, type IcsEvent } from '../lib/ical.js';
import { ratingSummary } from '../lib/reviews.js';
import {
  FACILITATOR_PUBLIC_COLUMNS,
  SERVICE_PUBLIC_COLUMNS,
  availableSlots,
  type ServiceRow,
  type FacilitatorSchedulingRow,
} from '../lib/scheduling.js';

/** How far ahead a single availability request may look. */
const MAX_RANGE_DAYS = 62;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const slug = event.pathParameters?.slug;
  const path = event.requestContext.http.path;

  // `await`ed rather than returned bare — see the note in bookings.ts. An
  // unawaited rejection here would escape this try entirely, costing the
  // `[facilitators]` log line that says why the directory failed to load.
  try {
    // Matched before the slug routes because it is a different resource
    // entirely — an unauthenticated feed keyed by a secret, not a directory
    // page keyed by a public slug.
    if (path.includes('/facilitator-calendar/')) {
      return await calendarFeed(event.pathParameters?.token ?? '');
    }
    if (!slug) return await list(event);
    if (path.endsWith('/availability')) return await availability(slug, event);
    return await detail(slug);
  } catch (err) {
    return serverError('facilitators', err);
  }
}

async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const specialty = event.queryStringParameters?.specialty?.trim();

  let query = supabase
    .from('facilitators')
    .select(FACILITATOR_PUBLIC_COLUMNS)
    .eq('status', 'published')
    .order('display_name');

  // Postgres array containment — matches a facilitator who lists this
  // specialty among others, rather than only an exact one-element match.
  if (specialty) query = query.contains('specialties', [specialty]);

  const { data, error } = await query;
  if (error) throw error;

  const facilitators = data ?? [];

  // The directory card shows a "from ₱X" price, which needs each facilitator's
  // cheapest paid service and whether they offer a free call. Done as one
  // batched query rather than N+1 per card.
  const ids = facilitators.map((f) => (f as { id: string }).id);
  const priceByFacilitator = new Map<string, { fromCentavos: number | null; hasFreeCall: boolean }>();

  if (ids.length > 0) {
    const { data: services, error: serviceError } = await supabase
      .from('facilitator_services')
      .select('facilitator_id, kind, price_centavos')
      .in('facilitator_id', ids)
      .eq('is_active', true);
    if (serviceError) throw serviceError;

    for (const row of services ?? []) {
      const id = row.facilitator_id as string;
      const entry = priceByFacilitator.get(id) ?? { fromCentavos: null, hasFreeCall: false };
      if (row.kind === 'exploratory') {
        entry.hasFreeCall = true;
      } else {
        const price = row.price_centavos as number;
        entry.fromCentavos = entry.fromCentavos === null ? price : Math.min(entry.fromCentavos, price);
      }
      priceByFacilitator.set(id, entry);
    }
  }

  return ok({
    facilitators: facilitators.map((f) => {
      const id = (f as { id: string }).id;
      const pricing = priceByFacilitator.get(id) ?? { fromCentavos: null, hasFreeCall: false };
      // From the running totals on the row (0036), so the whole directory is
      // still one query. An average of nothing is null, not zero stars.
      return { ...f, ...pricing, rating: ratingSummary(f as Record<string, number>) };
    }),
  });
}

async function detail(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: facilitator, error } = await supabase
    .from('facilitators')
    .select(FACILITATOR_PUBLIC_COLUMNS)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (error) throw error;
  if (!facilitator) return notFound('Facilitator not found');

  const { data: services, error: serviceError } = await supabase
    .from('facilitator_services')
    .select(SERVICE_PUBLIC_COLUMNS)
    .eq('facilitator_id', (facilitator as { id: string }).id)
    .eq('is_active', true)
    .order('sort_order')
    .order('price_centavos');

  if (serviceError) throw serviceError;

  // The most recent approved reviews, for the profile. Bounded: a profile is
  // a page someone reads before deciding, not an archive — the aggregate
  // carries the weight of the other two hundred.
  //
  // `booking_id` is deliberately absent, matching the RLS grant in 0013: it
  // would let anyone walk an approved review back to a specific session.
  const { data: reviews, error: reviewError } = await supabase
    .from('facilitator_reviews')
    .select('id, rating, comment, client_label, created_at')
    .eq('facilitator_id', (facilitator as { id: string }).id)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(20);

  if (reviewError) throw reviewError;

  // meeting_url is deliberately absent from SERVICE_PUBLIC_COLUMNS: a standing
  // Zoom room published on a public profile is an open door into every session
  // that facilitator runs. It reaches the client on their booking, after payment.
  return ok({
    facilitator,
    services: services ?? [],
    rating: ratingSummary(facilitator as Record<string, number>),
    reviews: reviews ?? [],
  });
}

async function availability(slug: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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
  // Bounded so a single request cannot ask the engine to project a decade of
  // weekly rules; the picker asks a fortnight at a time.
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    return badRequest(`Range must not exceed ${MAX_RANGE_DAYS} days`);
  }

  const supabase = await getSupabase();

  const { data: facilitator, error } = await supabase
    .from('facilitators')
    .select('id, timezone, vacation_until, status')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle<FacilitatorSchedulingRow>();

  if (error) throw error;
  if (!facilitator) return notFound('Facilitator not found');

  const { data: service, error: serviceError } = await supabase
    .from('facilitator_services')
    .select(SERVICE_PUBLIC_COLUMNS)
    .eq('id', serviceId)
    // Scoped to this facilitator so a service id from someone else's profile
    // cannot be used to read availability against these hours.
    .eq('facilitator_id', facilitator.id)
    .eq('is_active', true)
    .maybeSingle<ServiceRow>();

  if (serviceError) throw serviceError;
  if (!service) return notFound('Service not found');

  const slots = await availableSlots(supabase, facilitator, service, from, to, now);

  return ok({
    timezone: facilitator.timezone,
    durationMinutes: service.duration_minutes,
    // Only the client-facing pair; blockEndsAt is an internal scheduling
    // detail and telling the browser about the buffer invites confusion about
    // how long the session actually is.
    slots: slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
  });
}

// ---------------------------------------------------------------------------
// Calendar feed
// ---------------------------------------------------------------------------

/**
 * How much history the feed carries.
 *
 * Enough that a facilitator scrolling back a month still sees their sessions,
 * short of shipping their entire history to a calendar client on every poll.
 */
const FEED_HISTORY_DAYS = 90;

/**
 * The read-only `.ics` feed for one facilitator (0030).
 *
 * Unauthenticated by necessity: calendar clients poll on a schedule with no
 * session and no way to send a bearer token, so the credential is the random
 * token in the URL. See 0030 for what follows from that, and for how a leaked
 * link is remedied (rotate it — the old URL stops working at once).
 *
 * Cancelled sessions are included with `STATUS:CANCELLED` rather than dropped.
 * A subscriber that simply stops seeing an event may keep showing it forever;
 * an explicit cancellation is what actually clears it off the calendar, which
 * is the entire point of a facilitator not turning up to a session that was
 * called off.
 */
async function calendarFeed(rawToken: string): Promise<APIGatewayProxyResultV2> {
  // Subscribed as `.../TOKEN.ics` so the URL ends in an extension that
  // calendar apps and OS handlers recognise; API Gateway cannot express that
  // suffix in a path parameter, so it is stripped here.
  const token = rawToken.replace(/\.ics$/i, '').trim();
  if (!token || token.length < 32) return notFound('Calendar not found');

  const supabase = await getSupabase();

  const { data: facilitator, error } = await supabase
    .from('facilitators')
    .select('id, display_name, timezone')
    .eq('calendar_token', token)
    .maybeSingle<{ id: string; display_name: string; timezone: string }>();

  if (error) throw error;
  // Indistinguishable from a token that never existed, which is the point.
  if (!facilitator) return notFound('Calendar not found');

  const since = new Date(Date.now() - FEED_HISTORY_DAYS * 86_400_000).toISOString();

  const { data: bookings, error: bookingError } = await supabase
    .from('bookings')
    .select(
      'id, starts_at, ends_at, status, client_name, client_email, client_notes, meeting_url, updated_at, ' +
        'facilitator_services(title, duration_minutes)',
    )
    .eq('facilitator_id', facilitator.id)
    // A hold that was never paid for is not a commitment and has no business
    // on anyone's calendar.
    .neq('status', 'pending_payment')
    .gte('starts_at', since)
    .order('starts_at')
    .limit(1000);

  if (bookingError) throw bookingError;

  const cancelled = new Set(['cancelled_by_client', 'cancelled_by_facilitator', 'refunded']);

  const events: IcsEvent[] = (bookings ?? []).map((row: any) => {
    const client = row.client_name || row.client_email;
    const title = row.facilitator_services?.title ?? 'Session';
    const durationMinutes = row.facilitator_services?.duration_minutes;

    // `bookings.ends_at` is the *padded* end — it includes the service's buffer
    // so the exclusion constraint enforces it (0012). Blocking that padding out
    // on the facilitator's personal calendar would be wrong: the buffer stops
    // Hilom booking over it, it does not stop them doing something else. So the
    // event ends when the session does.
    const endsAt = durationMinutes
      ? new Date(new Date(row.starts_at).getTime() + durationMinutes * 60_000)
      : new Date(row.ends_at);

    return {
      // Stable across fetches, so a client updates an event rather than
      // replacing it and losing any alarm set on it.
      uid: `booking-${row.id}@hilomcollective.com`,
      startsAt: row.starts_at,
      endsAt,
      summary: `${title} — ${client}`,
      description: [
        `Client: ${client}`,
        row.client_notes ? `Their note: ${row.client_notes}` : null,
        'Manage this session at https://www.hilomcollective.com/facilitator/bookings',
      ]
        .filter(Boolean)
        .join('\n'),
      url: row.meeting_url,
      // Not a counter, but monotonic per event, which is all SEQUENCE has to
      // be for a client to recognise a newer version.
      sequence: Math.floor(new Date(row.updated_at ?? row.starts_at).getTime() / 1000),
      status: cancelled.has(row.status) ? ('CANCELLED' as const) : ('CONFIRMED' as const),
    };
  });

  const body = renderCalendar({
    name: `Hilom sessions — ${facilitator.display_name}`,
    events,
  });

  return text(200, body, 'text/calendar; charset=utf-8', {
    // Named so a downloaded copy is recognisable; `inline` because the normal
    // case is a calendar app fetching it, not a person saving it.
    'Content-Disposition': 'inline; filename="hilom-sessions.ics"',
    // Polling clients re-fetch on their own schedule; a cached hour-old feed
    // would hide a session booked twenty minutes ago.
    'Cache-Control': 'no-store',
  });
}

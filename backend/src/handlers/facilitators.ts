/**
 * Public facilitator directory.
 *
 *   GET /facilitators
 *   GET /facilitators/{slug}
 *   GET /facilitators/{slug}/availability?serviceId=&from=&to=
 *
 * Every query filters `status = 'published'` explicitly. The RLS policy in
 * 0011_facilitators.sql says the same thing, but the backend connects with the
 * secret key, which bypasses RLS entirely — so RLS is the second layer here,
 * not the first. Forgetting the filter would expose applications and suspended
 * profiles, which is precisely what the approval workflow exists to prevent.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError } from '../lib/http.js';
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

  try {
    if (!slug) return list(event);
    if (path.endsWith('/availability')) return availability(slug, event);
    return detail(slug);
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
      return { ...f, ...pricing };
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

  // meeting_url is deliberately absent from SERVICE_PUBLIC_COLUMNS: a standing
  // Zoom room published on a public profile is an open door into every session
  // that facilitator runs. It reaches the client on their booking, after payment.
  return ok({ facilitator, services: services ?? [] });
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

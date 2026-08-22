/**
 * Admin management of facilitators, bookings and payouts.
 *
 *   GET    /admin/facilitators
 *   GET    /admin/facilitators/{facilitatorId}
 *   PATCH  /admin/facilitators/{facilitatorId}
 *   GET    /admin/bookings
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
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAdminCaller } from '../lib/http.js';
import { addUserToGroup, removeUserFromGroup } from '../lib/cognito.js';
import { sendFacilitatorApproved } from '../lib/booking-email.js';
import { FacilitatorInputError } from '../lib/facilitator-input.js';

const ADMIN_FACILITATOR_COLUMNS =
  'id, slug, email, cognito_sub, display_name, headline, bio, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, legal_name, phone, timezone, status, platform_fee_bps, vacation_until, payout_details, admin_notes, applied_at, approved_at, created_at, updated_at';

const VALID_STATUSES = new Set(['applied', 'approved', 'published', 'suspended', 'rejected']);

/** Statuses that mean "this person should be able to open the dashboard". */
const DASHBOARD_STATUSES = new Set(['approved', 'published']);

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    const supabase = await getSupabase();

    if (path.includes('/admin/payouts')) return payouts(supabase, event, method);
    if (path.includes('/admin/bookings')) return listBookings(supabase, event);

    const facilitatorId = event.pathParameters?.facilitatorId;
    if (!facilitatorId) {
      if (method === 'GET') return listFacilitators(supabase, event);
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'GET') return getFacilitator(supabase, facilitatorId);
    if (method === 'PATCH') return patchFacilitator(supabase, facilitatorId, parseBody(event));
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof FacilitatorInputError) return badRequest(err.message);
    return serverError('adminFacilitators', err);
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

async function listFacilitators(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const status = event.queryStringParameters?.status?.trim();

  let query = supabase
    .from('facilitators')
    .select(ADMIN_FACILITATOR_COLUMNS)
    .order('applied_at', { ascending: false });

  if (status && VALID_STATUSES.has(status)) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return ok({ facilitators: data ?? [] });
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

  let query = supabase
    .from('bookings')
    .select('*, facilitators(slug, display_name, email), facilitator_services(title)')
    .order('starts_at', { ascending: false })
    .limit(200);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return ok({ bookings: data ?? [] });
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

  const { error: stampError } = await supabase
    .from('bookings')
    .update({ payout_id: payout.id })
    .in('id', bookings.map((b) => b.id as string))
    // Re-assert the unpaid condition: if a concurrent batch claimed some of
    // these between the read and this write, they stay with that batch rather
    // than being counted twice.
    .is('payout_id', null);

  if (stampError) throw stampError;

  return ok({ payout, sessionCount: bookings.length });
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

  const { data, error } = await supabase
    .from('facilitator_payouts')
    .update(patch)
    .eq('id', payoutId)
    .select(PAYOUT_COLUMNS)
    .maybeSingle();
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

  return ok({ payout: data });
}

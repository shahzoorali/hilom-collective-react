/**
 * Public event reads.
 *
 *   GET /events                    — published events, split upcoming/past
 *   GET /events/{eventId}/ticketing — what a registration page needs
 *
 * GET /events — published events, split into upcoming and past.
 *
 * The split happens here rather than in the frontend so "what counts as past"
 * has one implementation: coalesce(ends_at, starts_at) < now(), evaluated at
 * request time in the database, not recomputed client-side from timestamps
 * that could disagree with the server's clock.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError } from '../lib/http.js';
import {
  activePlans,
  registrationOpen,
  type PaymentPlan,
  type PlanInstallment,
} from '../lib/event-ticketing.js';

const COLUMNS =
  'id, title, subtitle, description, image_url, image_alt, location, starts_at, ends_at, link_url, link_label, note, ' +
  // Enough for the events list to render a "From ₱30,000 · 13 places" card and
  // a Register button instead of the generic outbound link. The prices
  // themselves come from the plans, so only the flag travels here.
  'ticketing_enabled, facilitators, gallery';

export async function handler(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const nowIso = new Date().toISOString();

    const [{ data: upcoming, error: upcomingError }, { data: past, error: pastError }] =
      await Promise.all([
        supabase
          .from('events')
          .select(COLUMNS)
          .eq('status', 'published')
          // An event with no end time counts as upcoming until its start
          // time passes; `.or` expresses "ends_at is null AND starts_at in
          // the future" OR "ends_at is set and still in the future" without a
          // computed column.
          .or(`ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${nowIso})`)
          .order('starts_at', { ascending: true }),
        supabase
          .from('events')
          .select(COLUMNS)
          .eq('status', 'published')
          .or(`ends_at.lt.${nowIso},and(ends_at.is.null,starts_at.lt.${nowIso})`)
          // Most recently ended first — the past section reads newest-to-oldest.
          .order('starts_at', { ascending: false }),
      ]);

    if (upcomingError) throw upcomingError;
    if (pastError) throw pastError;

    return ok({ upcoming: upcoming ?? [], past: past ?? [] });
  } catch (err) {
    return serverError('events.list', err);
  }
}

// ---------------------------------------------------------------------------

const TICKETING_COLUMNS =
  'id, title, subtitle, description, image_url, image_alt, location, starts_at, ends_at, ' +
  'status, ticketing_enabled, capacity, currency, registration_opens_at, registration_closes_at, ' +
  'hold_minutes, venue_details, terms_html, registrant_fields, facilitators, gallery';

interface TicketingEventRow {
  id: string;
  status: string;
  ticketing_enabled: boolean;
  capacity: number | null;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  [key: string]: unknown;
}

/**
 * Everything the registration page needs: the event, the plans currently on
 * offer with their schedules resolved, and how many places are left.
 *
 * **`placesRemaining` is advisory and says so.** It is a count taken outside
 * the row lock, so it is stale the moment it is returned; the authoritative
 * answer comes from claim_event_seat, which is why a registration can still
 * fail with `sold_out` after this said there was room. Shown to set
 * expectations ("2 places left"), never relied on to decide.
 *
 * Plans are filtered by their availability window here rather than in the
 * browser, so the September cutoff cannot be bypassed with a stale page — and
 * the same activePlans() the register endpoint uses makes that decision, so
 * the two cannot drift.
 */
export async function ticketing(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const eventId = event.pathParameters?.eventId;
    if (!eventId) return badRequest('Which event?');

    const supabase = await getSupabase();
    const now = new Date();

    const { data: eventRow, error } = await supabase
      .from('events')
      .select(TICKETING_COLUMNS)
      .eq('id', eventId)
      .maybeSingle<TicketingEventRow>();

    if (error) throw error;
    if (!eventRow || eventRow.status !== 'published' || !eventRow.ticketing_enabled) {
      return notFound('Event not found');
    }

    const { data: plans, error: planError } = await supabase
      .from('event_payment_plans')
      .select('id, name, description, kind, total_centavos, currency, available_from, available_until, is_active, sort_order')
      .eq('event_id', eventId)
      .returns<(PaymentPlan & { description: string | null })[]>();
    if (planError) throw planError;

    const offered = activePlans(plans ?? [], now);

    const { data: installments, error: instError } = offered.length
      ? await supabase
          .from('event_plan_installments')
          .select('plan_id, seq, label, amount_centavos, due_at, due_offset_days, is_deposit')
          .in('plan_id', offered.map((plan) => plan.id))
          .order('seq', { ascending: true })
          .returns<(PlanInstallment & { plan_id: string })[]>()
      : { data: [] as (PlanInstallment & { plan_id: string })[], error: null };
    if (instError) throw instError;

    const byPlan = new Map<string, PlanInstallment[]>();
    for (const inst of installments ?? []) {
      byPlan.set(inst.plan_id, [...(byPlan.get(inst.plan_id) ?? []), inst]);
    }

    const { count, error: countError } = await supabase
      .from('event_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .in('status', ['pending_payment', 'confirmed']);
    if (countError) throw countError;

    const taken = count ?? 0;
    const capacity = eventRow.capacity ?? 0;

    return ok({
      event: eventRow,
      open: registrationOpen({
        ticketingEnabled: eventRow.ticketing_enabled,
        status: eventRow.status,
        opensAt: eventRow.registration_opens_at,
        closesAt: eventRow.registration_closes_at,
        now,
      }),
      placesRemaining: Math.max(0, capacity - taken),
      plans: offered.map((plan) => ({
        ...plan,
        installments: (byPlan.get(plan.id) ?? []).map(({ seq, label, amount_centavos, due_at, due_offset_days, is_deposit }) => ({
          seq,
          label,
          amount_centavos,
          due_at,
          due_offset_days,
          is_deposit,
        })),
      })),
    });
  } catch (err) {
    return serverError('events.ticketing', err);
  }
}

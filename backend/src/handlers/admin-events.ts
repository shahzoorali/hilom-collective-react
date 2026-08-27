/**
 * Admin event management.
 *
 *   GET    /admin/events
 *   POST   /admin/events
 *   GET    /admin/events/{eventId}
 *   PUT    /admin/events/{eventId}
 *   DELETE /admin/events/{eventId}
 *   GET    /admin/events/{eventId}/plans
 *   PUT    /admin/events/{eventId}/plans
 *
 * No draft/publish split beyond the `status` column itself — unlike pages,
 * an event has no separate "what visitors see" copy to protect while editing,
 * so there is nothing a two-column draft/published pair would buy here.
 *
 * Ticketing (0016) rides on the same event row rather than a parallel table, so
 * it is edited here too. Every ticketing field is optional on the wire and
 * `validateTicketing` returns null when the body mentions none of them, which
 * is what lets the older listing-only form keep PUTting the shape it always
 * has without switching ticketing off by omission.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAuthorizedAdmin } from '../lib/http.js';
import { validateEvent, validateTicketing } from '../lib/cms-events.js';
import { BlockValidationError } from '../lib/cms-blocks.js';
import { validatePlans, TicketingValidationError } from '../lib/event-ticketing.js';
import { actorFromEvent, recordAudit } from '../lib/audit.js';

const COLUMNS =
  'id, title, subtitle, description, excerpt, image_id, image_url, image_alt, location, starts_at, ends_at, ' +
  'link_url, link_label, note, status, created_at, updated_at, ' +
  'ticketing_enabled, format, capacity, currency, registration_opens_at, registration_closes_at, ' +
  'hold_minutes, venue_details, terms_html, medical_disclaimer_html, liability_consent_html, ' +
  'registrant_fields, facilitators, gallery';

const PLAN_COLUMNS =
  'id, event_id, name, description, kind, total_centavos, currency, available_from, available_until, ' +
  'is_active, sort_order, created_at, updated_at';

const INSTALLMENT_COLUMNS = 'id, plan_id, seq, label, amount_centavos, due_at, due_offset_days, is_deposit';

/** Statuses that mean a registration is holding, or has held, a seat. */
const LIVE_STATUSES = ['pending_payment', 'confirmed', 'completed'];

// supabase-js is untyped here (there is no generated Database type — see
// supabase.ts), so shapes are declared per call rather than inferred. Without
// them `.select()` widens to a union including GenericStringError and every
// property access is an error.
interface EventRow extends Record<string, unknown> {
  id: string;
}
interface PlanRow extends Record<string, unknown> {
  id: string;
}
interface InstallmentRow extends Record<string, unknown> {
  plan_id: string;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const eventId = event.pathParameters?.eventId;

  try {
    // Every branch is awaited rather than returned. A returned pending promise
    // escapes this try before it rejects, which turns a validation error into
    // an uncaught Lambda rejection and a 502 with no log line worth reading.
    if (eventId && path.endsWith('/plans')) {
      if (method === 'GET') return await listPlans(eventId);
      if (method === 'PUT') return await replacePlans(event, eventId, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }

    if (!eventId) {
      if (method === 'GET') return await list();
      if (method === 'POST') return await create(event, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'GET') return await get(eventId);
    if (method === 'PUT') return await update(event, eventId, parseBody(event));
    if (method === 'DELETE') return await remove(eventId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof BlockValidationError) return badRequest(err.message);
    if (err instanceof TicketingValidationError) return badRequest(err.message);
    return serverError('adminEvents', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new BlockValidationError('Request body is not valid JSON');
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('events').select(COLUMNS).order('starts_at', { ascending: false });
  if (error) throw error;
  return ok({ events: data ?? [] });
}

async function get(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('events').select(COLUMNS).eq('id', eventId).maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');
  return ok({ event: data });
}

async function create(
  event: APIGatewayProxyEventV2,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const input = validateEvent(body);
  const ticketing = validateTicketing(body);

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('events')
    .insert({
      ...input,
      ...(ticketing ?? {}),
      status: body.status === 'published' ? 'published' : 'draft',
    })
    .select(COLUMNS)
    .maybeSingle<EventRow>();

  if (error) throw error;

  if (ticketing) {
    await recordAudit(actorFromEvent(event), {
      action: 'event.ticketing_updated',
      targetTable: 'events',
      targetId: data?.id ?? null,
      eventId: data?.id ?? null,
      after: ticketing,
      note: 'ticketing configured at creation',
    });
  }

  return ok({ event: data });
}

async function update(
  event: APIGatewayProxyEventV2,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const input = validateEvent(body);
  const ticketing = validateTicketing(body);

  const supabase = await getSupabase();

  // Read the current row before writing, both to have a `before` for the audit
  // trail and because the capacity guard below needs to compare against it.
  const { data: current, error: readError } = await supabase
    .from('events')
    .select(COLUMNS)
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (readError) throw readError;
  if (!current) return notFound('Event not found');

  if (ticketing?.capacity != null) {
    const guard = await capacityGuard(supabase, eventId, ticketing.capacity);
    if (guard) return guard;
  }

  const patch: Record<string, unknown> = { ...input, ...(ticketing ?? {}) };
  if (body.status === 'published' || body.status === 'draft') patch.status = body.status;

  const { data, error } = await supabase.from('events').update(patch).eq('id', eventId).select(COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');

  if (ticketing) {
    await recordAudit(actorFromEvent(event), {
      action: 'event.ticketing_updated',
      targetTable: 'events',
      targetId: eventId,
      eventId,
      before: pickTicketing(current),
      after: ticketing,
    });
  }

  return ok({ event: data });
}

/**
 * Refuses a capacity below the seats already sold.
 *
 * `claim_event_seat` reads capacity live, so lowering it does not cancel anyone
 * — it just stops new claims, and `min(g) over generate_series(1, capacity)`
 * quietly returns null for an event that is already over its new limit, which
 * surfaces as a confusing null-seat insert rather than a clear refusal. Catch it
 * here, where the admin can still see the number they typed.
 */
async function capacityGuard(
  supabase: SupabaseClient,
  eventId: string,
  capacity: number,
): Promise<APIGatewayProxyResultV2 | null> {
  const { count, error } = await supabase
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', ['pending_payment', 'confirmed']);
  if (error) throw error;

  const taken = count ?? 0;
  if (capacity < taken) {
    return json(409, {
      error:
        `${taken} ${taken === 1 ? 'seat is' : 'seats are'} already taken, so capacity cannot go down to ${capacity}. ` +
        'Cancel a registration first if you need to shrink the event.',
    });
  }
  return null;
}

function pickTicketing(row: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'ticketing_enabled',
    'format',
    'capacity',
    'currency',
    'registration_opens_at',
    'registration_closes_at',
    'hold_minutes',
    'registrant_fields',
  ];
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

async function remove(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  // event_registrations references events ON DELETE RESTRICT, so Postgres would
  // refuse this anyway — but a 500 with a foreign-key message is not an answer,
  // and "delete the event people paid for" deserves a sentence rather than a
  // constraint name.
  const { count, error: countError } = await supabase
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  if (countError) throw countError;

  if ((count ?? 0) > 0) {
    return json(409, {
      error:
        `This event has ${count} registration${count === 1 ? '' : 's'} against it and cannot be deleted. ` +
        'Set it back to draft to take it off the site — the record of what people paid has to stay.',
    });
  }

  const { error } = await supabase.from('events').delete().eq('id', eventId);
  if (error) throw error;
  return ok({ deleted: true });
}

// ---------------------------------------------------------------------------
// Payment plans
// ---------------------------------------------------------------------------

async function listPlans(eventId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const { data: plans, error } = await supabase
    .from('event_payment_plans')
    .select(PLAN_COLUMNS)
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true })
    .returns<PlanRow[]>();
  if (error) throw error;

  const planIds = (plans ?? []).map((p) => p.id);

  const { data: installments, error: instError } = planIds.length
    ? await supabase
        .from('event_plan_installments')
        .select(INSTALLMENT_COLUMNS)
        .in('plan_id', planIds)
        .order('seq', { ascending: true })
        .returns<InstallmentRow[]>()
    : { data: [] as InstallmentRow[], error: null };
  if (instError) throw instError;

  // How many people are on each plan. The editor needs this to explain why a
  // plan's schedule is locked, and "3 people are on this plan" is a better
  // reason than a greyed-out field with no explanation.
  const { data: regs, error: regError } = planIds.length
    ? await supabase
        .from('event_registrations')
        .select('plan_id, status')
        .eq('event_id', eventId)
        .in('status', LIVE_STATUSES)
        .returns<{ plan_id: string }[]>()
    : { data: [] as { plan_id: string }[], error: null };
  if (regError) throw regError;

  const counts = new Map<string, number>();
  for (const row of regs ?? []) {
    counts.set(row.plan_id, (counts.get(row.plan_id) ?? 0) + 1);
  }

  const byPlan = new Map<string, unknown[]>();
  for (const inst of installments ?? []) {
    const list = byPlan.get(inst.plan_id) ?? [];
    list.push(inst);
    byPlan.set(inst.plan_id, list);
  }

  return ok({
    plans: (plans ?? []).map((plan) => ({
      ...plan,
      installments: byPlan.get(plan.id) ?? [],
      registration_count: counts.get(plan.id) ?? 0,
      // Editable-but-locked, not read-only: name, description, availability
      // and the active flag can still change. See replace_event_plans.
      schedule_locked: (counts.get(plan.id) ?? 0) > 0,
    })),
  });
}

/**
 * Replaces the whole plan set for an event, in one transaction.
 *
 * This goes through the `replace_event_plans` RPC rather than a series of
 * PostgREST writes, and that is not a preference. 0016's totals trigger is
 * DEFERRABLE INITIALLY DEFERRED, and each PostgREST call is its own
 * transaction — so inserting instalments one row at a time fails on the first
 * one, because a single-row schedule never sums to the plan total. The RPC
 * writes the set in one statement so the trigger fires once, at commit, against
 * a complete schedule.
 */
async function replacePlans(
  event: APIGatewayProxyEventV2,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const plans = validatePlans(body.plans);

  const supabase = await getSupabase();

  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (eventError) throw eventError;
  if (!eventRow) return notFound('Event not found');

  const before = await listPlansRaw(supabase, eventId);

  const { error } = await supabase.rpc('replace_event_plans', {
    p_event_id: eventId,
    p_plans: plans,
  });

  if (error) {
    // The database re-checks the same invariants this handler validated, so a
    // check_violation here means the two disagreed — worth surfacing verbatim
    // rather than as a 500, because the message names the plan and the amounts.
    if (error.code === '23514' || error.message?.includes('instalments sum to')) {
      return badRequest(error.message);
    }
    if (error.message?.includes('plan_not_found')) {
      return badRequest('One of those plans belongs to a different event.');
    }
    throw error;
  }

  await recordAudit(actorFromEvent(event), {
    action: 'plan.replaced',
    targetTable: 'event_payment_plans',
    targetId: eventId,
    eventId,
    before,
    after: plans,
    note: `${plans.length} plan${plans.length === 1 ? '' : 's'} written`,
  });

  return await listPlans(eventId);
}

async function listPlansRaw(supabase: SupabaseClient, eventId: string): Promise<unknown> {
  const { data } = await supabase
    .from('event_payment_plans')
    .select(`${PLAN_COLUMNS}, event_plan_installments(${INSTALLMENT_COLUMNS})`)
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true });
  return data ?? [];
}

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
import { sendEventProposalDecision, sendEventEditDecision } from '../lib/booking-email.js';
import { sendEventChanged, type EmailEvent } from '../lib/registration-email.js';

const COLUMNS =
  'id, title, subtitle, description, excerpt, image_id, image_url, image_alt, location, starts_at, ends_at, ' +
  'link_url, link_label, note, status, created_at, updated_at, ' +
  'ticketing_enabled, format, capacity, currency, registration_opens_at, registration_closes_at, ' +
  'hold_minutes, venue_details, terms_html, medical_disclaimer_html, liability_consent_html, ' +
  'registrant_fields, facilitators, gallery, ' +
  // 0045. Admin-visible because an admin sets the host and can fix a bad
  // joining link without going through the facilitator's own dashboard.
  'facilitator_id, join_url, join_instructions, ' +
  // 0048. The moderation queue and the badge on every row in the list.
  'review_status, submitted_by, submitted_at, reviewed_at, review_note, ' +
  // 0054, step 3. Whether this date was pulled after going on sale.
  'cancelled_at, cancel_reason, ' +
  // 0058. A facilitator's pending edit to an already-approved event.
  'pending_changes, edit_submitted_at, edit_reviewed_at, edit_review_note, ' +
  // 0063. Raw hits on this date's ticket page.
  'view_count';

const PLAN_COLUMNS =
  'id, event_id, name, description, kind, total_centavos, currency, available_from, available_until, ' +
  'is_active, sort_order, created_at, updated_at';

const INSTALLMENT_COLUMNS = 'id, plan_id, seq, label, amount_centavos, due_at, due_offset_days, is_deposit';

/** Statuses that mean a registration is holding, or has held, a seat. */
const LIVE_STATUSES = ['pending_payment', 'confirmed', 'completed'];

/**
 * Statuses that occupy a seat *right now* — narrower than LIVE_STATUSES,
 * because a completed registration is somebody who has already been and gone
 * and is not standing between the next buyer and a place. This is the set
 * `claim_event_seat` counts against capacity, so the "12 of 20 taken" the
 * admin list shows and the number that decides sold-out are the same number.
 */
const SEAT_STATUSES = ['pending_payment', 'confirmed'];

// supabase-js is untyped here (there is no generated Database type — see
// supabase.ts), so shapes are declared per call rather than inferred. Without
// them `.select()` widens to a union including GenericStringError and every
// property access is an error.
interface EventRow extends Record<string, unknown> {
  id: string;
  ticketing_enabled?: boolean;
  status?: string;
  title?: string;
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
    if (eventId && path.endsWith('/review')) {
      if (method === 'PUT') return await review(event, eventId, parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }
    if (eventId && path.endsWith('/review-edit')) {
      if (method === 'PUT') return await reviewEdit(event, eventId, parseBody(event));
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

/**
 * Every event, plus the two derived numbers the admin list cannot render
 * without: how full a ticketed event is, and whether it has anything to sell.
 *
 * Both are counted here rather than per row, so the Events screen stays one
 * request, and only for ticketed events — a listing-only event has neither a
 * capacity to fill nor a plan to offer, and returning 0 for both would invite
 * the list to draw "0 of 0 seats" against something that never had seats.
 *
 * `active_plan_count` is what makes "publish a ticketed event with nothing to
 * buy" catchable before it happens. `validateTicketing` guards capacity and
 * format, but a plan lives in a different table and is saved by a different
 * call, so nothing on the write path has ever been in a position to notice.
 */
async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('events')
    .select(COLUMNS)
    .order('starts_at', { ascending: false })
    .returns<EventRow[]>();
  if (error) throw error;

  const events = data ?? [];
  const ticketed = events.filter((e) => e.ticketing_enabled).map((e) => e.id);

  const seats = new Map<string, number>();
  const plans = new Map<string, number>();

  if (ticketed.length > 0) {
    const [{ data: regRows, error: regError }, { data: planRows, error: planError }] = await Promise.all([
      supabase
        .from('event_registrations')
        .select('event_id')
        .in('event_id', ticketed)
        .in('status', SEAT_STATUSES)
        .returns<{ event_id: string }[]>(),
      supabase
        .from('event_payment_plans')
        .select('event_id')
        .in('event_id', ticketed)
        .eq('is_active', true)
        .returns<{ event_id: string }[]>(),
    ]);
    if (regError) throw regError;
    if (planError) throw planError;

    for (const row of regRows ?? []) seats.set(row.event_id, (seats.get(row.event_id) ?? 0) + 1);
    for (const row of planRows ?? []) plans.set(row.event_id, (plans.get(row.event_id) ?? 0) + 1);
  }

  return ok({
    events: events.map((e) =>
      e.ticketing_enabled
        ? { ...e, seats_taken: seats.get(e.id) ?? 0, active_plan_count: plans.get(e.id) ?? 0 }
        : e,
    ),
  });
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
  // A body carrying nothing but `status` is the list's publish/unpublish
  // toggle, not an edit of the event, and it takes a separate path on purpose.
  // Running it through validateEvent would demand a title and a start time the
  // toggle has no business resending — and resending them from a list row that
  // may be minutes stale is exactly how a one-click publish quietly reverts
  // somebody's copy.
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'status') {
    return await setStatus(event, eventId, body.status);
  }

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
 * Flips an event between draft and published, touching nothing else.
 *
 * Audited, because "who put this live, and when?" is a question worth being
 * able to answer about a page that takes money — and unlike an edit, a status
 * flip leaves no trace in the content itself.
 *
 * Unpublishing a ticketed event with people mid-registration is allowed rather
 * than refused: it is the documented way to take a sold event off the site (see
 * `remove` below), and blocking it here would leave an operator with no way to
 * stop the bleeding. The warning belongs at the click, which is where the admin
 * can still see how many seats are held.
 */
async function setStatus(
  event: APIGatewayProxyEventV2,
  eventId: string,
  raw: unknown,
): Promise<APIGatewayProxyResultV2> {
  if (raw !== 'draft' && raw !== 'published') {
    return badRequest('status must be either "draft" or "published"');
  }
  const status = raw;

  const supabase = await getSupabase();

  const { data: current, error: readError } = await supabase
    .from('events')
    .select('id, title, status')
    .eq('id', eventId)
    .maybeSingle<EventRow>();
  if (readError) throw readError;
  if (!current) return notFound('Event not found');

  const { data, error } = await supabase
    .from('events')
    .update({ status })
    .eq('id', eventId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');

  // No audit row for a no-op. A re-click that changed nothing is not an event
  // in the history of who published what.
  if (current.status !== status) {
    await recordAudit(actorFromEvent(event), {
      action: 'event.status_changed',
      targetTable: 'events',
      targetId: eventId,
      eventId,
      before: { status: current.status },
      after: { status },
      note: `"${current.title ?? 'Untitled event'}" ${status === 'published' ? 'published' : 'reverted to draft'}`,
    });
  }

  return ok({ event: data });
}

/**
 * Approve or reject a facilitator's event proposal (0048).
 *
 *   PUT /admin/events/{id}/review   { decision: 'approve' | 'reject', note?, publish? }
 *
 * ## Approval and publication are two decisions, not one
 *
 * `approve` sets `review_status` and nothing else by default. An admin
 * approving an event at 11pm may well not want it on the public calendar until
 * the copy has been read once more, and 0048's check constraint means
 * publishing is only *possible* after approval — it does not make it automatic.
 * `publish: true` does both in one call, which is the common case, and the
 * constraint still holds because both columns move in the same UPDATE.
 *
 * ## Rejection requires a note
 *
 * Enforced here rather than left to the UI. A rejection with no reason produces
 * a support thread every time, and the facilitator's own screen renders this
 * text verbatim as the only explanation they get.
 */
async function review(
  event: APIGatewayProxyEventV2,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const decision = String(body.decision ?? '');
  if (decision !== 'approve' && decision !== 'reject') {
    return badRequest('decision must be either "approve" or "reject"');
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  if (decision === 'reject' && !note) {
    return badRequest('Say why it was rejected — the facilitator sees this note.');
  }

  const supabase = await getSupabase();

  const { data: current, error: readError } = await supabase
    .from('events')
    // submitted_by, not facilitator_id: the decision is addressed to whoever
    // proposed the event, which is not necessarily who ends up hosting it.
    .select('id, title, status, review_status, submitted_by, facilitators:submitted_by(email, display_name, short_name)')
    .eq('id', eventId)
    .maybeSingle<
      EventRow & {
        review_status: string;
        submitted_by: string | null;
        facilitators: { email: string; display_name: string; short_name: string | null } | null;
      }
    >();
  if (readError) throw readError;
  if (!current) return notFound('Event not found');

  const patch: Record<string, unknown> = {
    review_status: decision === 'approve' ? 'approved' : 'rejected',
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  };

  // Rejecting an event that is somehow already live takes it down with the
  // same call, because the constraint would otherwise refuse the update and
  // leave an admin unable to act on it at all.
  if (decision === 'approve' && body.publish === true) patch.status = 'published';
  if (decision === 'reject') patch.status = 'draft';

  // A facilitator's proposal is a revenue share, the same as a series (0054):
  // without a rate every charge records a null split and the host is never
  // paid. Required here for the same reason seriesReview requires it — no
  // silent default. An admin-created event (no submitted_by) is Hilom's own.
  if (decision === 'approve' && current.submitted_by) {
    const bps = body.platform_fee_bps === undefined || body.platform_fee_bps === null ? NaN : Number(body.platform_fee_bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return badRequest('Set a commission (0–10000 basis points) before approving a facilitator’s event.');
    }
    patch.platform_fee_bps = bps;
  }

  const { data, error } = await supabase
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');

  // Best-effort, like every other notification in this codebase: the decision
  // is recorded and the row is correct, so a failed send is recoverable in a
  // way that failing the admin's action is not.
  //
  // An event with no `submitted_by` was created by an admin rather than
  // proposed, so there is nobody waiting to hear — that is the ordinary case
  // for every event predating 0048, not an error.
  if (current.submitted_by && current.facilitators?.email) {
    await sendEventProposalDecision({
      to: current.facilitators.email,
      facilitatorName: current.facilitators.short_name || current.facilitators.display_name,
      eventTitle: current.title ?? 'your event',
      approved: decision === 'approve',
      reviewNote: note || null,
      published: patch.status === 'published',
    }).catch((err: unknown) => {
      console.error('[adminEvents.review] decision email failed', { eventId, err });
    });
  }

  await recordAudit(actorFromEvent(event), {
    action: decision === 'approve' ? 'event.approved' : 'event.rejected',
    targetTable: 'events',
    targetId: eventId,
    eventId,
    before: { review_status: current.review_status, status: current.status },
    after: { review_status: patch.review_status, status: patch.status ?? current.status },
    note: `"${current.title ?? 'Untitled event'}" ${decision === 'approve' ? 'approved' : 'rejected'}${note ? `: ${note}` : ''}`,
  });

  return ok({ event: data });
}

/**
 * Approve or reject a facilitator's proposed edit to an already-approved
 * event (0058).
 *
 *   PUT /admin/events/{id}/review-edit   { decision: 'approve' | 'reject', note? }
 *
 * Distinct from `review()` above on purpose: this never touches
 * `review_status` or `status` — the event was already approved and, unless an
 * admin chooses to unpublish it for some other reason, stays exactly as
 * published throughout. Approving here copies `pending_changes` onto the row
 * in the same statement that clears it; rejecting only clears it. Either way
 * `edit_reviewed_at`/`edit_review_note` are kept, the same "survive the
 * decision" choice `review_note` makes in 0048.
 */
async function reviewEdit(
  event: APIGatewayProxyEventV2,
  eventId: string,
  body: Record<string, unknown>,
): Promise<APIGatewayProxyResultV2> {
  const decision = String(body.decision ?? '');
  if (decision !== 'approve' && decision !== 'reject') {
    return badRequest('decision must be either "approve" or "reject"');
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  if (decision === 'reject' && !note) {
    return badRequest('Say why — the facilitator sees this note.');
  }

  const supabase = await getSupabase();

  const { data: current, error: readError } = await supabase
    .from('events')
    .select(
      'id, title, pending_changes, submitted_by, facilitator_id, ' +
        'facilitators:facilitator_id(email, display_name, short_name)',
    )
    .eq('id', eventId)
    .maybeSingle<{
      id: string;
      title: string;
      pending_changes: Record<string, unknown> | null;
      submitted_by: string | null;
      facilitator_id: string | null;
      facilitators: { email: string; display_name: string; short_name: string | null } | null;
    }>();
  if (readError) throw readError;
  if (!current) return notFound('Event not found');
  if (!current.pending_changes) return badRequest('There is no edit awaiting review on this event.');

  const patch: Record<string, unknown> = {
    edit_reviewed_at: new Date().toISOString(),
    edit_review_note: note || null,
    pending_changes: null,
  };
  if (decision === 'approve') Object.assign(patch, current.pending_changes);

  const { data, error } = await supabase
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Event not found');

  if (decision === 'approve') {
    await notifyRegistrantsOfChange(supabase, eventId, current.pending_changes);
  }

  // The host, not necessarily the proposer — an edit is something the current
  // host is asking for, and the host is who has to live with the answer.
  if (current.facilitators?.email) {
    await sendEventEditDecision({
      to: current.facilitators.email,
      facilitatorName: current.facilitators.short_name || current.facilitators.display_name,
      eventTitle: current.title ?? 'your event',
      approved: decision === 'approve',
      reviewNote: note || null,
    }).catch((err: unknown) => {
      console.error('[adminEvents.reviewEdit] decision email failed', { eventId, err });
    });
  }

  await recordAudit(actorFromEvent(event), {
    action: decision === 'approve' ? 'event.edit_approved' : 'event.edit_rejected',
    targetTable: 'events',
    targetId: eventId,
    eventId,
    before: current.pending_changes,
    after: decision === 'approve' ? current.pending_changes : null,
    note: `"${current.title ?? 'Untitled event'}" edit ${decision === 'approve' ? 'approved' : 'rejected'}${note ? `: ${note}` : ''}`,
  });

  return ok({ event: data });
}

const CHANGE_WORDS: Record<string, string> = {
  title: 'name',
  starts_at: 'time',
  ends_at: 'time',
  location: 'place',
  format: 'format',
};

/**
 * Tells everyone holding a place that an approved edit changed what they
 * registered for, and re-arms the day-before reminder when the time moved so
 * it fires for the new date rather than having already gone for the old one.
 *
 * Best-effort per person, like every other send: the edit is already applied,
 * and one bounced address must not stop the rest being told.
 */
async function notifyRegistrantsOfChange(
  supabase: SupabaseClient,
  eventId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const changed = [...new Set(Object.keys(changes).map((k) => CHANGE_WORDS[k] ?? k))];
  if (changed.length === 0) return;

  if ('starts_at' in changes) {
    const { error } = await supabase
      .from('event_registrations')
      .update({ reminder_sent_at: null })
      .eq('event_id', eventId)
      .eq('status', 'confirmed');
    if (error) console.error('[adminEvents.reviewEdit] could not re-arm reminders', { eventId, error });
  }

  const { data: event } = await supabase
    .from('events')
    .select('title, starts_at, ends_at, location, venue_details, format, join_url, join_instructions')
    .eq('id', eventId)
    .maybeSingle<EmailEvent>();
  if (!event) return;

  const { data: registrations } = await supabase
    .from('event_registrations')
    .select('id, buyer_email, registrant_name')
    .eq('event_id', eventId)
    .in('status', ['pending_payment', 'confirmed'])
    .returns<{ id: string; buyer_email: string; registrant_name: string }[]>();

  for (const r of registrations ?? []) {
    try {
      await sendEventChanged({
        to: r.buyer_email,
        registrantName: r.registrant_name,
        registrationId: r.id,
        event,
        changed,
      });
    } catch (err) {
      console.error('[adminEvents.reviewEdit] change email failed', { registrationId: r.id, err });
    }
  }
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
    .in('status', SEAT_STATUSES);
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

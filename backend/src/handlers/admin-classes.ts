/**
 * Admin -> Classes (0049, and docs/admin-dashboard-plan.md §5).
 *
 *   GET  /admin/classes                              — every class, across facilitators
 *   GET  /admin/classes/{classId}/sessions            — its occurrences + rosters
 *   POST /admin/classes/sessions/{sessionId}/cancel   — cancel one occurrence
 *
 * Before this file, a facilitator could create a class, schedule dates, see
 * who joined and cancel one — an admin could do none of it. The only
 * class-shaped thing in the panel was the refund queue inside Payouts. If a
 * facilitator stopped responding a week before a class, there was no lever:
 * no way to see who was booked, no way to cancel it.
 *
 * **Cancellation does not get reimplemented here.** It calls the exact
 * function the facilitator portal calls (lib/class-cancellation.ts), so the
 * refund figures and the attendee emails are identical whoever pressed the
 * button. The only difference is `cancelled_by`, which the shared function
 * already accepts as 'admin' (0049's check constraint always allowed it).
 *
 * Authorized with `isAdminCaller`, which accepts a Cognito admin token or the
 * legacy shared key — see the note on that function. Every write is audited.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAdminCaller } from '../lib/http.js';
import { adminActorFromEvent, recordAudit } from '../lib/audit.js';
import { cancelClassSession } from '../lib/class-cancellation.js';

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const classId = event.pathParameters?.classId;
  const sessionId = event.pathParameters?.sessionId;

  try {
    const supabase = await getSupabase();

    if (sessionId && path.endsWith('/cancel')) {
      if (method !== 'POST') return badRequest(`Unsupported method ${method}`);
      return await adminCancelSession(supabase, sessionId, parseBody(event), event);
    }

    if (classId && path.endsWith('/sessions')) {
      if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
      return await listSessions(supabase, classId);
    }

    if (!classId && !sessionId) {
      if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
      return await listClasses(supabase);
    }

    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    return serverError('adminClasses', err);
  }
}

/** Every class any facilitator teaches, plus what the list screen needs without a second round trip. */
const CLASS_COLUMNS =
  'id, facilitator_id, title, description, duration_minutes, price_centavos, currency, ' +
  'is_pay_what_you_want, min_centavos, suggested_centavos, ' +
  'max_joiners, min_joiners, meeting_url, is_active, created_at, ' +
  'facilitators(slug, display_name, email)';

interface ClassRow extends Record<string, unknown> {
  id: string;
  facilitator_id: string;
}

/**
 * Every class, active or not — an admin needs to see a deactivated class that
 * still has scheduled dates on it as much as a live one, since those dates
 * still have to be dealt with if something goes wrong.
 *
 * Upcoming-session counts and next dates are read in one extra query rather
 * than N — the same shape as adminListEvents' seat counting — so this stays
 * one request regardless of how many classes exist.
 */
async function listClasses(supabase: SupabaseClient): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_classes')
    .select(CLASS_COLUMNS)
    .order('created_at', { ascending: false })
    .returns<ClassRow[]>();
  if (error) throw error;

  const classes = data ?? [];
  if (classes.length === 0) return ok({ classes: [] });

  const now = new Date().toISOString();
  const { data: sessionRows, error: sessionError } = await supabase
    .from('facilitator_class_sessions')
    .select('id, class_id, starts_at, capacity, status')
    .in('class_id', classes.map((c) => c.id))
    .eq('status', 'scheduled')
    .gte('starts_at', now)
    .order('starts_at', { ascending: true })
    .returns<{ id: string; class_id: string; starts_at: string; capacity: number; status: string }[]>();
  if (sessionError) throw sessionError;

  const upcomingByClass = new Map<string, typeof sessionRows>();
  for (const s of sessionRows ?? []) {
    const list = upcomingByClass.get(s.class_id) ?? [];
    list.push(s);
    upcomingByClass.set(s.class_id, list);
  }

  // Live seat counts for those upcoming sessions only — a class with nothing
  // scheduled has nothing to count, and this is the figure the plan asks for
  // on the list screen ("scheduled dates ... with live seat counts").
  const upcomingSessionIds = (sessionRows ?? []).map((s) => s.id);
  const seatsBySession = new Map<string, number>();
  if (upcomingSessionIds.length > 0) {
    const { data: seatRows, error: seatError } = await supabase
      .from('class_registrations')
      .select('session_id')
      .in('session_id', upcomingSessionIds)
      .in('status', ['pending_payment', 'confirmed'])
      .returns<{ session_id: string }[]>();
    if (seatError) throw seatError;
    for (const r of seatRows ?? []) {
      seatsBySession.set(r.session_id, (seatsBySession.get(r.session_id) ?? 0) + 1);
    }
  }

  return ok({
    classes: classes.map((c) => {
      const upcoming = upcomingByClass.get(c.id) ?? [];
      return {
        ...c,
        upcomingSessionCount: upcoming.length,
        nextSessionAt: upcoming[0]?.starts_at ?? null,
        // Seats on the *next* date only — the list row has room for one
        // number, and the next date is the one an operator is about to ask
        // "how full is this?" about. The sessions screen has the rest.
        nextSessionSeatsTaken: upcoming[0] ? seatsBySession.get(upcoming[0].id) ?? 0 : null,
      };
    }),
  });
}

/**
 * Every occurrence of one class, with who is on it — the roster the plan asks
 * for. Same shape as the facilitator portal's own listClassSessions, minus the
 * ownership filter: an admin can open any facilitator's class.
 */
async function listSessions(supabase: SupabaseClient, classId: string): Promise<APIGatewayProxyResultV2> {
  const { data: cls, error: clsError } = await supabase
    .from('facilitator_classes')
    .select(CLASS_COLUMNS)
    .eq('id', classId)
    .maybeSingle<ClassRow>();
  if (clsError) throw clsError;
  if (!cls) return notFound('Class not found');

  const { data: sessions, error } = await supabase
    .from('facilitator_class_sessions')
    .select('*')
    .eq('class_id', classId)
    .order('starts_at', { ascending: false })
    .returns<Record<string, unknown>[]>();
  if (error) throw error;

  const rows = sessions ?? [];
  if (rows.length === 0) return ok({ class: cls, sessions: [] });

  const { data: registrations, error: regError } = await supabase
    .from('class_registrations')
    .select('id, session_id, client_email, client_name, client_notes, status, seat_no, refund_centavos, refunded_at')
    .in('session_id', rows.map((s) => s.id as string))
    .in('status', ['pending_payment', 'confirmed', 'completed', 'cancelled'])
    .order('seat_no', { ascending: true })
    .returns<Record<string, unknown>[]>();
  if (regError) throw regError;

  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const r of registrations ?? []) {
    const sessionId = r.session_id as string;
    const list = bySession.get(sessionId) ?? [];
    list.push(r);
    bySession.set(sessionId, list);
  }

  return ok({
    class: cls,
    sessions: rows.map((s) => {
      const roster = bySession.get(s.id as string) ?? [];
      const live = roster.filter((r) => r.status !== 'cancelled');
      const paid = live.filter((r) => r.status !== 'pending_payment');
      return {
        ...s,
        roster,
        seatsTaken: live.length,
        meetsMinimum: paid.length >= Number(s.min_joiners),
      };
    }),
  });
}

/**
 * Cancels one occurrence, through lib/class-cancellation.ts — see that file
 * and this file's header for why there is only one implementation.
 *
 * The facilitator row is read here (rather than trusted from the path) so the
 * cancellation email says the right name and the right timezone, and so the
 * shared function's ownership filter has a real facilitator_id to match
 * against — it is a no-op check for this caller, but costs nothing to keep
 * the same code path as the facilitator's own cancel.
 */
async function adminCancelSession(
  supabase: SupabaseClient,
  sessionId: string,
  body: Record<string, unknown>,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : null;

  const { data: session, error: sessionError } = await supabase
    .from('facilitator_class_sessions')
    .select('facilitator_id, facilitator_classes(title)')
    .eq('id', sessionId)
    .maybeSingle<{ facilitator_id: string; facilitator_classes: { title: string } | null }>();
  if (sessionError) throw sessionError;
  if (!session) return notFound('Session not found');

  const { data: facilitator, error: facError } = await supabase
    .from('facilitators')
    .select('id, display_name, timezone')
    .eq('id', session.facilitator_id)
    .maybeSingle<{ id: string; display_name: string; timezone: string }>();
  if (facError) throw facError;
  if (!facilitator) return notFound('Facilitator not found');

  const result = await cancelClassSession(supabase, facilitator, sessionId, reason, 'admin');
  if (!result) return notFound('Session not found, or already cancelled');

  await recordAudit(await adminActorFromEvent(event), {
    action: 'class_session.cancel',
    targetTable: 'facilitator_class_sessions',
    targetId: sessionId,
    amountCentavos: result.refundTotalCentavos > 0 ? result.refundTotalCentavos : null,
    currency: 'PHP',
    after: { status: 'cancelled', refunds_owed: result.refundsOwed },
    note:
      `${session.facilitator_classes?.title ?? 'class'}: ${result.registrationsCancelled} registration` +
      `${result.registrationsCancelled === 1 ? '' : 's'} cancelled` +
      (reason ? ` — ${reason}` : ''),
  });

  return ok(result);
}

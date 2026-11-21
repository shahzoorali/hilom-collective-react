/**
 * Admin → Dashboard: what needs a human right now.
 *
 *   GET /admin/overview   ?days=7
 *
 * One endpoint rather than seven list calls from the browser. The existing
 * list endpoints return **full rows** — `/admin/bookings` every booking,
 * `/admin/registrations` every registration with its charges — so counting
 * them client-side would make the landing page the slowest and most expensive
 * screen in the panel, fetching megabytes to render seven integers.
 *
 * Everything here is count-only (`select('id', { count: 'exact', head: true })`)
 * apart from the money line, which reads one integer column over a seven-day
 * window. The predicates come from lib/admin-queues.ts, shared with the list
 * endpoints, so a count and the screen it links to cannot disagree about what
 * the queue contains — see that file for why that mattered enough to factor
 * out.
 *
 * Read-only, and nothing here is audited: looking at a dashboard is not an
 * action anybody needs held accountable for.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { adminActorFromEvent, recordAudit } from '../lib/audit.js';
import { countQueues, revenueSince, latePaymentsOpen } from '../lib/admin-queues.js';

/** Bounded because it reaches a query; 90 days keeps the money read small. */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.rawPath ?? '';

  // Late payments (0079): GET lists the open ones, POST …/{id}/resolve closes one.
  if (path.endsWith('/admin/late-payments') && method === 'GET') return await listLatePayments();
  const resolveMatch = path.match(/\/admin\/late-payments\/([0-9a-f-]{36})\/resolve$/);
  if (resolveMatch && method === 'POST') return await resolveLatePayment(resolveMatch[1]!, event);

  if (method !== 'GET') return badRequest(`Unsupported method ${method}`);

  const raw = event.queryStringParameters?.days;
  const days = raw === undefined ? DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return badRequest(`days must be a whole number between 1 and ${MAX_DAYS}`);
  }

  try {
    const supabase = await getSupabase();
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [queues, revenue] = await Promise.all([
      countQueues(supabase, now),
      revenueSince(supabase, since),
    ]);

    return ok({
      generatedAt: now.toISOString(),
      queues,
      money: {
        days,
        since: since.toISOString(),
        // Stated in the response, not only in the UI, so a caller reading this
        // JSON cannot mistake it for a net figure. Refunds are manual here and
        // are not subtracted — see revenueSince.
        basis: 'gross collected, refunds not deducted',
        currency: 'PHP',
        totalCentavos: revenue.reduce((acc, line) => acc + line.centavos, 0),
        bySource: revenue,
      },
    });
  } catch (err) {
    return serverError('adminOverview', err);
  }
}

async function listLatePayments(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await latePaymentsOpen(
      supabase
        .from('late_payments')
        .select('id, kind, source_id, paymongo_payment_id, amount_centavos, currency, client_email, detail, created_at'),
    )
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return ok({ latePayments: data ?? [] });
  } catch (err) {
    return serverError('adminLatePayments.list', err);
  }
}

/** Marks one resolved, with a note (e.g. "refunded via BPI, ref 123"). Audited. */
async function resolveLatePayment(id: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let note = '';
  try {
    note = String((JSON.parse(event.body ?? '{}') as { note?: unknown }).note ?? '').trim();
  } catch {
    return badRequest('Body must be JSON');
  }
  if (!note) return badRequest('Say what was done (refunded, rebooked, ...)');
  if (note.length > 1000) return badRequest('Note is too long');
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('late_payments')
      .update({ resolved_at: new Date().toISOString(), resolved_by: (await adminActorFromEvent(event)).label, resolution_note: note })
      .eq('id', id)
      .is('resolved_at', null)
      .select('id')
      .maybeSingle<{ id: string }>();
    if (error) throw error;
    if (!data) return badRequest('Not found or already resolved');
    const actor = await adminActorFromEvent(event);
    await recordAudit(actor, { action: 'late_payment.resolve', targetTable: 'late_payments', targetId: id, note });
    return ok({ resolved: true });
  } catch (err) {
    return serverError('adminLatePayments.resolve', err);
  }
}

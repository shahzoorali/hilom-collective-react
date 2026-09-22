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
import { countQueues, revenueSince } from '../lib/admin-queues.js';

/** Bounded because it reaches a query; 90 days keeps the money read small. */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
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

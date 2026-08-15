/**
 * GET /orders/status/{paymentId}
 *
 * Polled by the post-payment "setting up your access" screen until the order
 * reaches `fulfilled`.
 *
 * Access control: the PayMongo payment id is a long unguessable string that
 * only the buyer's own browser receives (from the attach response), so it acts
 * as the capability token here. This still returns the bare minimum — status
 * and the course links — never the buyer email, amount, or internal error
 * detail, so a leaked or guessed id discloses nothing useful about a customer.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getPayMongoSecret } from '../lib/secrets.js';
import { ok, badRequest, serverError, unauthorized, isAuthorizedAdmin } from '../lib/http.js';

/** Shared shape for both lookup routes. */
async function statusForPaymentId(paymentId: string) {
  const supabase = await getSupabase();
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, status, product_id')
    .eq('paymongo_payment_id', paymentId)
    .maybeSingle<{ id: string; status: string; product_id: string }>();

  if (error) throw error;
  if (!order) return { status: 'pending', productName: null, productSlug: null };

  const { data: product } = await supabase
    .from('products')
    .select('name, slug')
    .eq('id', order.product_id)
    .maybeSingle<{ name: string; slug: string }>();

  return {
    status: order.status,
    productName: product?.name ?? null,
    productSlug: product?.slug ?? null,
  };
}

export async function status(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const paymentId = event.pathParameters?.paymentId;
  if (!paymentId) return badRequest('Missing paymentId');

  try {
    // A missing order is normal in the seconds right after payment — the
    // webhook simply hasn't landed yet. The client keeps polling on 'pending'.
    return ok(await statusForPaymentId(paymentId));
  } catch (err) {
    return serverError('orders.status', err);
  }
}

/**
 * GET /orders/status-by-intent/{intentId}
 *
 * The browser cannot discover its own payment id: PayMongo returns `payments`
 * as an EMPTY array to public-key clients (verified against the live API), so
 * an attach response tells the browser the payment succeeded but not which
 * payment it was. Only the secret key sees the payment records — hence this
 * route, which resolves intent -> payment id server-side and then answers
 * exactly as the by-payment route does.
 *
 * Like that route, the id is an unguessable capability token and the response
 * deliberately excludes buyer email, amount, and internal error detail.
 */
export async function statusByIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const intentId = event.pathParameters?.intentId;
  if (!intentId) return badRequest('Missing intentId');

  try {
    const { secretKey } = await getPayMongoSecret();
    const res = await fetch(`https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
    });

    if (!res.ok) {
      // An unknown or invalid intent id is a client mistake, not a server fault.
      if (res.status === 404) return ok({ status: 'pending', productName: null, productSlug: null });
      throw new Error(`PayMongo intent lookup failed (${res.status})`);
    }

    const json = (await res.json()) as {
      data?: { attributes?: { payments?: Array<{ id: string }> } };
    };
    const paymentId = json.data?.attributes?.payments?.[0]?.id;

    // No payment recorded yet — the card may still be mid-authorization.
    if (!paymentId) return ok({ status: 'pending', productName: null, productSlug: null });

    return ok(await statusForPaymentId(paymentId));
  } catch (err) {
    return serverError('orders.statusByIntent', err);
  }
}

/**
 * GET /orders/status-by-session/{sessionId}
 *
 * The hosted-checkout equivalent of statusByIntent: the browser knows only the
 * checkout session id it was redirected with, never the payment id, so the
 * session is resolved to its payment server-side with the secret key.
 *
 * Same access-control reasoning as the routes above — the session id is an
 * unguessable capability token, and the response deliberately excludes buyer
 * email, amount, and internal error detail.
 */
export async function statusBySession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing sessionId');

  try {
    const { secretKey } = await getPayMongoSecret();
    const res = await fetch(
      `https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` } },
    );

    if (!res.ok) {
      // An unknown or invalid session id is a client mistake, not a server fault.
      if (res.status === 404) return ok({ status: 'pending', productName: null, productSlug: null });
      throw new Error(`PayMongo session lookup failed (${res.status})`);
    }

    const json = (await res.json()) as {
      data?: { attributes?: { payments?: Array<{ id: string }> } };
    };
    const paymentId = json.data?.attributes?.payments?.[0]?.id;

    // No payment recorded yet — with QRPh this is the normal state for as long
    // as the buyer has the QR open but has not completed the scan.
    if (!paymentId) return ok({ status: 'pending', productName: null, productSlug: null });

    return ok(await statusForPaymentId(paymentId));
  } catch (err) {
    return serverError('orders.statusBySession', err);
  }
}

/**
 * GET /admin/orders — the admin panel's stuck-order view.
 *
 * Admin-only, so unlike the buyer-facing endpoint above this returns the full
 * row including buyer email and error_detail, which is the entire point: an
 * admin needs to see *why* an order is stuck to decide whether retrying will
 * help.
 */
export async function adminList(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const statusFilter = event.queryStringParameters?.status;

  try {
    const supabase = await getSupabase();
    let query = supabase
      .from('orders')
      .select('id, paymongo_payment_id, product_id, buyer_email, amount_centavos, currency, status, moodle_user_id, error_detail, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) throw error;

    return ok({ orders: data ?? [] });
  } catch (err) {
    return serverError('orders.adminList', err);
  }
}

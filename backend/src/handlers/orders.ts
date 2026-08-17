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
import { ok, badRequest, notFound, serverError, unauthorized, isAuthorizedAdmin } from '../lib/http.js';

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
 * One row as PostgREST returns it, with the product embedded. Declared rather
 * than inferred because the generated Supabase types do not model embedded
 * resources, and the inferred row is not an object type you can rest-spread.
 */
interface AdminOrderRow {
  products: {
    name: string;
    slug: string;
    product_courses: { moodle_course_id: number }[];
  } | null;
  [key: string]: unknown;
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
      // `cognito_user_sub` and the joined product are here for support, not for
      // the list view: "they paid but can't see the course" is either a missing
      // Moodle enrolment or a missing Cognito identity, and telling those apart
      // used to mean querying the database by hand. The product join answers
      // "what should this person have?" — `product_id` alone is an opaque uuid,
      // and `product_courses` is the authoritative list of what the sale grants.
      .select(
        'id, paymongo_payment_id, product_id, buyer_email, amount_centavos, currency, status, ' +
          'cognito_user_sub, moodle_user_id, error_detail, created_at, updated_at, ' +
          'products(name, slug, product_courses(moodle_course_id))',
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) throw error;

    // Flatten the join so the client sees a plain order row rather than having
    // to know how PostgREST nests embedded resources.
    const rows = (data ?? []) as unknown as AdminOrderRow[];
    const orders = rows.map(({ products, ...order }) => ({
      ...order,
      product_name: products?.name ?? null,
      product_slug: products?.slug ?? null,
      moodle_course_ids: (products?.product_courses ?? []).map((c) => c.moodle_course_id),
    }));

    return ok({ orders });
  } catch (err) {
    return serverError('orders.adminList', err);
  }
}

/**
 * PayMongo's payment resource, narrowed to the fields support actually reads.
 * The live payload carries considerably more — see docs.paymongo.com — and is
 * deliberately not modeled in full, matching the approach in lib/paymongo.ts.
 */
interface PayMongoPayment {
  data?: {
    id: string;
    attributes?: {
      status?: string;
      amount?: number;
      fee?: number;
      net_amount?: number;
      currency?: string;
      paid_at?: number | null;
      description?: string | null;
      source?: { type?: string } | null;
      billing?: { name?: string | null; email?: string | null; phone?: string | null } | null;
      payment_method_used?: string | null;
      refunds?: { id: string; amount?: number; status?: string; created_at?: number }[] | null;
    };
  };
  errors?: { detail?: string }[];
}

/**
 * GET /admin/orders/{orderId}/payment — the transaction behind an order.
 *
 * Nothing in our own database records *how* someone paid: the webhook stores
 * only the amount and the payment id, so questions support is actually asked
 * ("did the refund go through?", "was this GCash or a card?", "what did we
 * actually net?") could previously only be answered in the PayMongo dashboard.
 *
 * This proxies rather than mirrors deliberately. Fees and refund state change
 * on PayMongo's side after the payment is captured, so a copy in our own tables
 * would be a second source of truth that is wrong exactly when it matters.
 *
 * Admin-only and server-side: the PayMongo secret key must never reach the
 * browser, so the frontend gets this curated projection and nothing else.
 */
export async function adminPayment(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return badRequest('Missing orderId');

  try {
    const supabase = await getSupabase();
    const { data: order, error } = await supabase
      .from('orders')
      .select('paymongo_payment_id')
      .eq('id', orderId)
      .maybeSingle<{ paymongo_payment_id: string }>();

    if (error) throw error;
    if (!order) return notFound('Order not found');

    // Checkout-session orders are keyed by the session id until the payment
    // itself settles, and /v1/payments/{id} only accepts a real payment id.
    if (!order.paymongo_payment_id.startsWith('pay_')) {
      return ok({
        available: false,
        reason:
          `Recorded PayMongo id "${order.paymongo_payment_id}" is not a payment id, ` +
          'so no transaction detail can be fetched for it yet.',
      });
    }

    const { secretKey } = await getPayMongoSecret();
    const res = await fetch(`https://api.paymongo.com/v1/payments/${order.paymongo_payment_id}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
    });

    const body = (await res.json().catch(() => ({}))) as PayMongoPayment;

    if (!res.ok) {
      // Surfaced rather than thrown: a 404 from PayMongo is a real answer for
      // support ("this id does not exist in the account we're authenticated
      // against"), and is far more useful than a generic 500 here.
      return ok({
        available: false,
        reason: body.errors?.[0]?.detail ?? `PayMongo returned HTTP ${res.status}.`,
      });
    }

    const a = body.data?.attributes ?? {};
    const refunds = a.refunds ?? [];

    return ok({
      available: true,
      payment: {
        id: body.data?.id ?? order.paymongo_payment_id,
        status: a.status ?? null,
        // `source.type` is the method for e-wallet/QR payments; card payments
        // report it as payment_method_used instead. Support just wants "how".
        method: a.source?.type ?? a.payment_method_used ?? null,
        amount_centavos: a.amount ?? null,
        fee_centavos: a.fee ?? null,
        net_centavos: a.net_amount ?? null,
        currency: a.currency ?? null,
        paid_at: a.paid_at ? new Date(a.paid_at * 1000).toISOString() : null,
        description: a.description ?? null,
        billing_name: a.billing?.name ?? null,
        billing_email: a.billing?.email ?? null,
        billing_phone: a.billing?.phone ?? null,
        refunds: refunds.map((r) => ({
          id: r.id,
          amount_centavos: r.amount ?? null,
          status: r.status ?? null,
          created_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
        })),
        refunded_centavos: refunds.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      },
    });
  } catch (err) {
    return serverError('orders.adminPayment', err);
  }
}

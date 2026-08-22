/**
 * POST /checkout/create-session
 *
 * Creates a PayMongo Checkout Session and hands the browser back the hosted
 * `checkout_url` to redirect to.
 *
 * Why hosted checkout rather than the Payment Intent + card-attach flow this
 * used to run: the account has no card acquiring enabled — only QRPh — so
 * there is nothing to tokenize a card against. QRPh is a scan-to-pay method,
 * which has no client-side equivalent of `/payment_intents/{id}/attach`; the
 * QR has to be rendered on PayMongo's own page. That also removes raw card
 * data from our infrastructure entirely, rather than merely routing it around
 * us.
 *
 * Chosen over the Payment Links API (`/v1/payment_links`, the dashboard's
 * "one-time transaction link") because links have no `success_url`: the buyer
 * would be left on PayMongo's page after paying with no route back to the
 * enrollment-progress screen. Links are built for manual invoicing, sessions
 * for programmatic checkout.
 *
 * The price is read from the database here and never taken from the request —
 * otherwise anyone could POST their own amount and buy a bundle for ₱1. The
 * buyer's email is treated the same way, and for the same reason: it comes from
 * a verified Cognito id_token, never from the request body. Course access is
 * permanent and keyed to that address, so letting the caller name it freely
 * would be a way to provision access on somebody else's account.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getPayMongoSecret } from '../lib/secrets.js';
import { ok, badRequest, notFound, serverError, unauthorized } from '../lib/http.js';
import { requireBuyer, UnauthorizedError } from '../lib/auth.js';
import { accessUrl } from '../lib/access-url.js';

interface CreateSessionBody {
  slug?: string;
  /**
   * Display name for the PayMongo receipt only. Unlike email this is cosmetic —
   * nothing is keyed to it — so accepting it from the body is fine. It falls
   * back to the token's name claims when absent.
   */
  name?: string;
}

/**
 * Which methods the hosted page offers. Env-driven so that enabling GCash or
 * card later is a config change, not a redeploy of code — the only hard
 * requirement is that every value here is actually activated on the PayMongo
 * account, or session creation 400s.
 */
const PAYMENT_METHODS = (process.env.CHECKOUT_PAYMENT_METHODS ?? 'qrph')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function createSession(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let buyer;
  try {
    buyer = await requireBuyer(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('checkout.createSession', err);
  }

  let body: CreateSessionBody;
  try {
    body = JSON.parse(event.body ?? '{}') as CreateSessionBody;
  } catch {
    return badRequest('Malformed body');
  }

  const slug = body.slug?.trim();
  if (!slug) return badRequest('Missing slug');

  const email = buyer.email;
  const name =
    body.name?.trim() || [buyer.givenName, buyer.familyName].filter(Boolean).join(' ') || undefined;

  // Deliberately not derived from CORS_ORIGIN (which is '*' in this env): the
  // bare apex domain only 301s "/" to www — every other path, including this
  // one, hits Amplify's apex-redirect microservice directly and 404s without
  // ever reaching the app. Same pitfall as the Moodle host; www is required.
  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';

  try {
    const supabase = await getSupabase();
    const { data: product, error } = await supabase
      .from('products')
      .select('id, name, slug, description, price_centavos, currency, is_active')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle<{
        id: string;
        name: string;
        slug: string;
        description: string | null;
        price_centavos: number;
        currency: string;
      }>();

    if (error) throw error;
    if (!product) return notFound('Product not found');

    // Block repurchase of anything the buyer already owns (fulfilled order,
    // any course overlap — catches "bought the bundle, now tries a course in
    // it" as well as an exact repeat) rather than sending them through PayMongo
    // to pay again for access they already have.
    const { data: thisProductCourses } = await supabase
      .from('product_courses')
      .select('moodle_course_id')
      .eq('product_id', product.id);
    const thisCourseIds = (thisProductCourses ?? []).map((r) => r.moodle_course_id as number);

    const { data: ownedOrders } = await supabase
      .from('orders')
      .select('product_id')
      .eq('buyer_email', email)
      .eq('status', 'fulfilled');
    const ownedProductIds = [...new Set((ownedOrders ?? []).map((r) => r.product_id as string))];

    if (ownedProductIds.length > 0 && thisCourseIds.length > 0) {
      const { data: ownedCourseRows } = await supabase
        .from('product_courses')
        .select('moodle_course_id')
        .in('product_id', ownedProductIds);
      const ownedCourseIds = new Set((ownedCourseRows ?? []).map((r) => r.moodle_course_id as number));
      const overlap = thisCourseIds.filter((id) => ownedCourseIds.has(id));

      if (overlap.length > 0) {
        return ok({ alreadyOwned: true, accessUrl: accessUrl(overlap) });
      }
    }

    const { secretKey } = await getPayMongoSecret();

    const res = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            payment_method_types: PAYMENT_METHODS,
            line_items: [
              {
                name: product.name,
                amount: product.price_centavos,
                currency: product.currency,
                quantity: 1,
              },
            ],
            // Prefilled so the buyer does not retype what they just gave us,
            // and so the receipt goes to the same address we enroll.
            billing: { email, ...(name ? { name } : {}) },
            description: product.name,
            send_email_receipt: true,
            show_line_items: true,
            // The webhook reads these back to know what to fulfill and for
            // whom — without them a paid session cannot be mapped to a product.
            metadata: {
              product_id: product.id,
              buyer_email: email,
              product_slug: product.slug,
            },
            // PayMongo cannot template the session id into these, so the
            // browser stashes it before redirecting (see Checkout.tsx).
            success_url: `${origin}/checkout/processing`,
            cancel_url: `${origin}/courses/${product.slug}`,
          },
        },
      }),
    });

    const json = (await res.json()) as {
      data?: { id: string; attributes: { checkout_url: string } };
      errors?: unknown;
    };

    if (!res.ok || !json.data) {
      console.error('[checkout.createSession] PayMongo rejected session', JSON.stringify(json.errors ?? json));
      return serverError('checkout.createSession', new Error('PayMongo session creation failed'));
    }

    return ok({
      sessionId: json.data.id,
      checkoutUrl: json.data.attributes.checkout_url,
      amountCentavos: product.price_centavos,
      currency: product.currency,
      productName: product.name,
    });
  } catch (err) {
    return serverError('checkout.createSession', err);
  }
}

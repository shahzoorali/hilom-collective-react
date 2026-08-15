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
 * otherwise anyone could POST their own amount and buy a bundle for ₱1.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getPayMongoSecret } from '../lib/secrets.js';
import { ok, badRequest, notFound, serverError } from '../lib/http.js';

interface CreateSessionBody {
  slug?: string;
  email?: string;
  name?: string;
}

// Deliberately loose: PayMongo will reject anything genuinely invalid, and an
// over-strict regex here would reject valid addresses for no benefit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  let body: CreateSessionBody;
  try {
    body = JSON.parse(event.body ?? '{}') as CreateSessionBody;
  } catch {
    return badRequest('Malformed body');
  }

  const slug = body.slug?.trim();
  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  if (!slug) return badRequest('Missing slug');
  if (!email || !EMAIL_RE.test(email)) return badRequest('A valid email is required');

  const origin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
    ? process.env.CORS_ORIGIN
    : 'https://hilomcollective.com';

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

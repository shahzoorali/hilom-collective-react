/**
 * POST /checkout/create-intent
 *
 * Creates a PayMongo Payment Intent for a product and hands the browser back
 * the `client_key` it needs to attach a card.
 *
 * The card itself never touches this server: the browser creates the payment
 * method directly against PayMongo with the *public* key, then attaches it
 * using the client key. That keeps raw card data entirely out of our
 * infrastructure.
 *
 * The price is read from the database here and never taken from the request —
 * otherwise anyone could POST their own amount and buy a bundle for ₱1.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { getPayMongoSecret } from '../lib/secrets.js';
import { ok, badRequest, notFound, serverError } from '../lib/http.js';

interface CreateIntentBody {
  slug?: string;
  email?: string;
}

// Deliberately loose: PayMongo will reject anything genuinely invalid, and an
// over-strict regex here would reject valid addresses for no benefit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createIntent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: CreateIntentBody;
  try {
    body = JSON.parse(event.body ?? '{}') as CreateIntentBody;
  } catch {
    return badRequest('Malformed body');
  }

  const slug = body.slug?.trim();
  const email = body.email?.trim().toLowerCase();
  if (!slug) return badRequest('Missing slug');
  if (!email || !EMAIL_RE.test(email)) return badRequest('A valid email is required');

  try {
    const supabase = await getSupabase();
    const { data: product, error } = await supabase
      .from('products')
      .select('id, name, slug, price_centavos, currency, is_active')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle<{
        id: string;
        name: string;
        slug: string;
        price_centavos: number;
        currency: string;
      }>();

    if (error) throw error;
    if (!product) return notFound('Product not found');

    const { secretKey, publicKey } = await getPayMongoSecret();

    const res = await fetch('https://api.paymongo.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: product.price_centavos,
            currency: product.currency,
            payment_method_allowed: ['card'],
            payment_method_options: { card: { request_three_d_secure: 'automatic' } },
            capture_type: 'automatic',
            description: product.name,
            // The webhook reads these back to know what to fulfill and for
            // whom — without them a paid payment cannot be mapped to a product.
            metadata: { product_id: product.id, buyer_email: email, product_slug: product.slug },
          },
        },
      }),
    });

    const json = (await res.json()) as { data?: { id: string; attributes: { client_key: string } }; errors?: unknown };
    if (!res.ok || !json.data) {
      console.error('[checkout.createIntent] PayMongo rejected intent', JSON.stringify(json.errors ?? json));
      return serverError('checkout.createIntent', new Error('PayMongo intent creation failed'));
    }

    return ok({
      intentId: json.data.id,
      clientKey: json.data.attributes.client_key,
      publicKey, // publishable by design — the browser needs it to tokenize the card
      amountCentavos: product.price_centavos,
      currency: product.currency,
      productName: product.name,
    });
  } catch (err) {
    return serverError('checkout.createIntent', err);
  }
}

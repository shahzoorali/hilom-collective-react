/**
 * Test-harness only — drives PayMongo's test-mode Payment Intents API directly
 * to produce a genuine `payment.paid` webhook delivery, without going through
 * PayMongo's hosted Checkout Sessions UI (a third-party React app that proved
 * unreliable to drive via browser automation — its "Card" method-select button
 * did not respond to any click, real or synthetic). This is PayMongo's own
 * documented way to test programmatically; it is NOT the real checkout flow —
 * Phase 7 builds the actual on-site UI.
 *
 *   cd backend && npx tsx ../scripts/paymongo-test-checkout.ts <product-slug> <buyer-email>
 *
 * Uses test card 4343434343434345 (Visa, always succeeds, no 3DS challenge).
 */
import { getSupabaseSecret } from '../backend/src/lib/secrets.js';
import { getPayMongoSecret } from '../backend/src/lib/secrets.js';

const slug = process.argv[2];
const buyerEmail = process.argv[3];
if (!slug || !buyerEmail) {
  console.error('usage: paymongo-test-checkout.ts <product-slug> <buyer-email>');
  process.exit(1);
}

const { url: supabaseUrl, secretKey: supabaseSecretKey } = await getSupabaseSecret();
const productRes = await fetch(
  `${supabaseUrl}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}&select=id,name,price_centavos,currency`,
  { headers: { apikey: supabaseSecretKey, Authorization: `Bearer ${supabaseSecretKey}` } },
);
const products = (await productRes.json()) as Array<{
  id: string;
  name: string;
  price_centavos: number;
  currency: string;
}>;
const product = products[0];
if (!productRes.ok || !product) {
  console.error(`Product ${slug} not found:`, JSON.stringify(products));
  process.exit(1);
}

const { secretKey } = await getPayMongoSecret();
const auth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

async function pm(pathname: string, body: unknown) {
  const res = await fetch(`https://api.paymongo.com/v1${pathname}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: any; errors?: unknown };
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

console.log(`Product:  ${product.name} (${slug})`);
console.log(`Amount:   ${product.price_centavos} ${product.currency}`);
console.log(`Buyer:    ${buyerEmail}\n`);

const intent = await pm('/payment_intents', {
  data: {
    attributes: {
      amount: product.price_centavos,
      currency: product.currency,
      payment_method_allowed: ['card'],
      payment_method_options: { card: { request_three_d_secure: 'automatic' } },
      capture_type: 'automatic',
      description: `Test purchase: ${product.name}`,
      metadata: { product_id: product.id, buyer_email: buyerEmail },
    },
  },
});
console.log(`Payment intent: ${intent.id} (${intent.attributes.status})`);

const paymentMethod = await pm('/payment_methods', {
  data: {
    attributes: {
      type: 'card',
      details: { card_number: '4343434343434345', exp_month: 12, exp_year: 2030, cvc: '123' },
      billing: { email: buyerEmail, name: 'Test Buyer' },
    },
  },
});
console.log(`Payment method: ${paymentMethod.id}`);

const attached = await pm(`/payment_intents/${intent.id}/attach`, {
  data: {
    attributes: {
      payment_method: paymentMethod.id,
      client_key: intent.attributes.client_key,
      return_url: 'https://hilomcollective.com/checkout/success',
    },
  },
});

console.log(`\nFinal status: ${attached.attributes.status}`);
if (attached.attributes.status !== 'succeeded') {
  console.log('Did not succeed synchronously — response:', JSON.stringify(attached.attributes, null, 2));
}

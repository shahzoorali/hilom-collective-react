/**
 * Creating a PayMongo hosted checkout.
 *
 * paymongo.ts deliberately holds only webhook verification — the inbound half.
 * This is the outbound half, extracted from the byte-identical `fetch` blocks
 * that had grown in checkout.ts and bookings.ts. A third copy was about to
 * appear for event registrations, and the copies had already begun to drift:
 * only one of them logged `errors` in a way you could read.
 *
 * Everything specific to a purchase is a parameter; everything shared — the
 * Basic auth encoding, the activated payment methods, receipt and line-item
 * flags, the response shape and the error logging — lives here once.
 *
 * **On payment method.** Only QRPh is activated on the account
 * (CHECKOUT_PAYMENT_METHODS, default 'qrph'), which has a consequence worth
 * stating where the code is rather than in a design document: there is no card
 * on file, so nothing in this system can ever auto-charge anyone. Every
 * instalment is a push payment the registrant chooses to make, which is why
 * the reminder tiers matter more here than anywhere else in the product.
 *
 * **On Checkout Sessions rather than Payment Links.** Sessions carry a
 * `metadata` object, and the entire webhook dispatch is built on it
 * (paymongo-webhook.ts branches on `metadata.kind`). Links carry no metadata,
 * so adopting them would mean a second correlation mechanism keyed on link id —
 * a database read before dispatch, and two ways for a payment to find its row.
 * If the account is ever restricted to Links, this module's interface is the
 * seam: only its body and the webhook's normalize() would change.
 */
import { getPayMongoSecret } from './secrets.js';

const PAYMENT_METHODS = (process.env.CHECKOUT_PAYMENT_METHODS ?? 'qrph')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

export class PayMongoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayMongoError';
  }
}

export interface CheckoutRequest {
  /** Shown as the line item on the hosted page and the receipt. */
  name: string;
  description: string;
  amountCentavos: number;
  currency: string;
  /**
   * `name` is nullable rather than merely optional because callers get it from
   * a nullable column (bookings.client_name) or an optional form field, and
   * making each of them normalise would be three chances to get it wrong.
   */
  billing: { email: string; name?: string | null | undefined };
  /**
   * Read back by the webhook to decide what this payment fulfils. Values must
   * be strings — PayMongo returns numbers and booleans here inconsistently.
   */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** `cs_…`. Stored so a status poll can find the row before the webhook lands. */
  sessionId: string;
  checkoutUrl: string;
}

/**
 * Opens a hosted checkout session.
 *
 * Throws PayMongoError on any non-2xx. Callers are expected to catch it and
 * release whatever they were holding — a booking's slot, a registration's
 * seat — rather than leaving it parked behind a payment that was never started.
 */
export async function createHostedCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
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
              name: req.name,
              amount: req.amountCentavos,
              currency: req.currency,
              quantity: 1,
            },
          ],
          // Prefilled so the buyer does not retype what they just gave us, and
          // so the receipt goes to the same address we act on.
          billing: { email: req.billing.email, ...(req.billing.name ? { name: req.billing.name } : {}) },
          description: req.description,
          send_email_receipt: true,
          show_line_items: true,
          metadata: req.metadata,
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
        },
      },
    }),
  });

  const payload = (await res.json()) as {
    data?: { id: string; attributes: { checkout_url: string } };
    errors?: unknown;
  };

  if (!res.ok || !payload.data) {
    // The errors array is where PayMongo says which attribute it disliked, and
    // it is the only useful thing in a failure. Logged as JSON because the
    // shape varies and a stringified object would read "[object Object]".
    console.error(
      `[paymongo-checkout] session rejected (${res.status}):`,
      JSON.stringify(payload.errors ?? payload),
    );
    throw new PayMongoError('PayMongo session creation failed');
  }

  return {
    sessionId: payload.data.id,
    checkoutUrl: payload.data.attributes.checkout_url,
  };
}

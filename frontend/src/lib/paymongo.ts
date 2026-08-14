/**
 * Client-side PayMongo card payment.
 *
 * Card number/CVC are POSTed from the browser straight to PayMongo using the
 * *public* key and never pass through our own API — that is the whole point of
 * this file, and it keeps raw card data out of our infrastructure entirely.
 *
 * The backend creates the payment intent (so the amount comes from the
 * database, not the browser); this only tokenizes the card and attaches it.
 */

export interface CardInput {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  name: string;
  email: string;
}

export interface AttachResult {
  status: string;
  /** Present when the issuer requires a 3-D Secure challenge. */
  redirectUrl?: string;
  lastError?: string;
}

/**
 * Note there is deliberately no payment id here. PayMongo returns `payments[]`
 * as an EMPTY array to public-key clients (verified against the live API), so
 * the browser cannot learn its own payment id. Fulfillment is tracked by
 * payment *intent* id via our own backend instead.
 */

function authHeader(publicKey: string): string {
  return `Basic ${btoa(`${publicKey}:`)}`;
}

async function pmFetch(publicKey: string, path: string, body: unknown) {
  const res = await fetch(`https://api.paymongo.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(publicKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: any; errors?: Array<{ detail?: string }> };
  if (!res.ok) {
    throw new Error(json.errors?.[0]?.detail ?? `PayMongo request failed (${res.status})`);
  }
  return json.data;
}

export async function payWithCard(
  publicKey: string,
  intentId: string,
  clientKey: string,
  card: CardInput,
): Promise<AttachResult> {
  const method = await pmFetch(publicKey, '/payment_methods', {
    data: {
      attributes: {
        type: 'card',
        details: {
          card_number: card.number.replace(/\s+/g, ''),
          exp_month: card.expMonth,
          exp_year: card.expYear,
          cvc: card.cvc,
        },
        billing: { name: card.name, email: card.email },
      },
    },
  });

  const attached = await pmFetch(publicKey, `/payment_intents/${intentId}/attach`, {
    data: {
      attributes: {
        payment_method: method.id,
        client_key: clientKey,
        return_url: `${window.location.origin}/checkout/processing`,
      },
    },
  });

  const attrs = attached.attributes;
  return {
    status: attrs.status,
    redirectUrl: attrs.next_action?.redirect?.url,
    lastError: attrs.last_payment_error?.detail ?? attrs.last_payment_error?.message,
  };
}

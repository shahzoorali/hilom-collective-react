/**
 * PayMongo webhook signature verification and event typing.
 *
 * PayMongo signs each webhook delivery with `Paymongo-Signature`, formatted
 * as `t=<unix-timestamp>,te=<test-mode-hmac>,li=<live-mode-hmac>` — only the
 * field matching the webhook's mode is meaningfully populated. The signed
 * payload is `${t}.${rawRequestBody}`, HMAC-SHA256'd with the webhook's own
 * signing secret (distinct per-webhook, not the API secret key).
 *
 * The raw, unparsed request body must be used — re-serializing parsed JSON
 * would silently break every signature that involves float/key-order
 * normalization.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class SignatureVerificationError extends Error {}

function parseSignatureHeader(header: string): { timestamp: string; test?: string; live?: string } {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  if (!parts.t) throw new SignatureVerificationError('Missing t= in Paymongo-Signature header');
  return { timestamp: parts.t, test: parts.te, live: parts.li };
}

/**
 * Throws SignatureVerificationError if the signature doesn't match. Returns
 * void on success — callers should treat "did not throw" as verified.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string, webhookSecret: string): void {
  const { timestamp, test, live } = parseSignatureHeader(signatureHeader);
  const candidate = test ?? live;
  if (!candidate) throw new SignatureVerificationError('Neither te= nor li= present in signature header');

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const candidateBuf = Buffer.from(candidate, 'hex');
  if (
    expectedBuf.length !== candidateBuf.length ||
    !timingSafeEqual(expectedBuf, candidateBuf)
  ) {
    throw new SignatureVerificationError('Signature mismatch');
  }
}

/**
 * Only the fields fulfillment actually needs. PayMongo's payload has more —
 * see docs.paymongo.com — deliberately not modeled in full here.
 */
export interface PayMongoWebhookEvent {
  data: {
    id: string;
    attributes: {
      type: string;
      livemode: boolean;
      data: {
        id: string;
        attributes: {
          amount: number;
          currency: string;
          status?: string;
          billing?: { email?: string | null; name?: string | null } | null;
          metadata?: Record<string, string> | null;
        };
      };
    };
  };
}

export function parseWebhookEvent(rawBody: string): PayMongoWebhookEvent {
  return JSON.parse(rawBody) as PayMongoWebhookEvent;
}

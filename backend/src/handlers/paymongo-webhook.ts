/**
 * POST /webhooks/paymongo
 *
 * Flow (per the plan, in this exact order):
 *   1. Verify the signature against the raw body.
 *   2. Write the order row FIRST, before any enrollment attempt — dedup on
 *      `paymongo_payment_id` makes this safe against PayMongo's at-least-once
 *      delivery.
 *   3. Attempt fulfillment. On failure, leave the order recoverable
 *      (`paid_pending_enrollment` + `error_detail`) and push to the retry
 *      queue rather than losing it.
 *
 * Always returns 200 once the signature is valid, regardless of whether
 * fulfillment succeeded — PayMongo's retry/backoff is for delivery failures,
 * not business-logic failures, and the SQS queue is the real retry path for
 * those. Returning non-2xx here would just make PayMongo re-deliver the same
 * event, which the dedupe already handles for free.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getPayMongoSecret } from '../lib/secrets.js';
import { verifyWebhookSignature, parseWebhookEvent, SignatureVerificationError } from '../lib/paymongo.js';
import { getSupabase } from '../lib/supabase.js';
import { fulfillOrder } from '../lib/fulfillment.js';
import { enqueueRetry } from '../lib/retry-queue.js';
import { ok, badRequest, serverError } from '../lib/http.js';

const FULFILLABLE_EVENT_TYPES = new Set(['payment.paid', 'checkout_session.payment.paid']);

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.body ?? '';
  const signatureHeader = event.headers['paymongo-signature'] ?? event.headers['Paymongo-Signature'];

  if (!signatureHeader) {
    console.warn('[paymongo-webhook] missing signature header');
    return badRequest('Missing signature');
  }

  try {
    const { webhookSecret } = await getPayMongoSecret();
    verifyWebhookSignature(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    if (err instanceof SignatureVerificationError) {
      console.warn('[paymongo-webhook] signature verification failed', err.message);
      return badRequest('Invalid signature');
    }
    return serverError('paymongo-webhook.verify', err);
  }

  let webhookEvent;
  try {
    webhookEvent = parseWebhookEvent(rawBody);
  } catch (err) {
    console.warn('[paymongo-webhook] malformed JSON body');
    return badRequest('Malformed body');
  }

  const eventType = webhookEvent.data.attributes.type;
  const paymentData = webhookEvent.data.attributes.data;

  if (!FULFILLABLE_EVENT_TYPES.has(eventType)) {
    // payment.failed, source.chargeable, etc. — nothing to fulfill, just ack.
    console.log(`[paymongo-webhook] ignoring event type ${eventType}`);
    return ok({ received: true, handled: false, type: eventType });
  }

  const paymentId = paymentData.id;
  const metadata = paymentData.attributes.metadata ?? {};
  const productId = metadata.product_id;
  const buyerEmail = metadata.buyer_email ?? paymentData.attributes.billing?.email;

  if (!productId || !buyerEmail) {
    // A payment.paid event we can't map to a product/buyer is a bug in
    // checkout (missing metadata), not a transient failure — retrying it
    // via SQS would never succeed, so this is logged loudly instead of queued.
    console.error('[paymongo-webhook] payment.paid missing product_id/buyer_email metadata', {
      paymentId,
      metadata,
    });
    return ok({ received: true, handled: false, error: 'missing_metadata' });
  }

  try {
    const supabase = await getSupabase();

    // Insert-or-ignore on the dedupe key, then read back whichever row exists
    // (freshly inserted, or the one from a prior delivery of this same event).
    const { error: insertError } = await supabase.from('orders').insert({
      paymongo_payment_id: paymentId,
      product_id: productId,
      buyer_email: buyerEmail,
      amount_centavos: paymentData.attributes.amount,
      currency: paymentData.attributes.currency,
      status: 'paid_pending_enrollment',
    });
    // Unique violation on paymongo_payment_id is the expected redelivery
    // case, not an error — every other insert failure is real.
    if (insertError && insertError.code !== '23505') throw insertError;

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, status')
      .eq('paymongo_payment_id', paymentId)
      .single();
    if (fetchError) throw fetchError;
    if (!order) throw new Error(`Order for payment ${paymentId} vanished immediately after insert`);

    if (order.status === 'fulfilled') {
      return ok({ received: true, handled: true, status: 'already_fulfilled' });
    }

    try {
      const result = await fulfillOrder(order.id, paymentData.attributes.billing?.name);
      return ok({ received: true, handled: true, status: result.status });
    } catch (fulfillErr) {
      const message = fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr);
      console.error('[paymongo-webhook] fulfillment failed, queuing retry', { orderId: order.id, message });
      await enqueueRetry(order.id, message);
      // Still 200: the payment is durably recorded, and the retry queue owns
      // recovery from here. A 5xx would only cause PayMongo to redeliver the
      // same event, which just re-runs this same failing path.
      return ok({ received: true, handled: true, status: 'queued_for_retry' });
    }
  } catch (err) {
    return serverError('paymongo-webhook', err);
  }
}

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
import { confirmBooking } from '../lib/booking-fulfillment.js';
import { enqueueRetry } from '../lib/retry-queue.js';
import { ok, badRequest, serverError } from '../lib/http.js';

const FULFILLABLE_EVENT_TYPES = new Set(['payment.paid', 'checkout_session.payment.paid']);

interface NormalizedPayment {
  paymentId: string | undefined;
  amountCentavos: number | undefined;
  currency: string | undefined;
  metadata: Record<string, string | undefined>;
  billingName: string | undefined;
  billingEmail: string | undefined;
}

/**
 * The two fulfillable event types carry different resources, and both are
 * subscribed, so a single hosted-checkout purchase fires *both*:
 *
 *   payment.paid                  -> data is a payment      (id `pay_…`)
 *   checkout_session.payment.paid -> data is a checkout session (id `cs_…`),
 *                                    with the real payment inside `payments[]`
 *
 * A checkout session has no top-level `amount` or `currency` — those live on
 * the payment (or, before one exists, on `line_items`). Reading them off the
 * session directly wrote NULLs into the order row.
 *
 * Everything is keyed on the *payment* id rather than whichever resource the
 * event happened to carry, so the two events for one purchase collapse onto a
 * single order row via the existing unique constraint instead of creating two.
 */
function normalize(eventType: string, data: any): NormalizedPayment {
  const attrs = data.attributes ?? {};

  if (eventType === 'checkout_session.payment.paid') {
    const payment = attrs.payments?.[0];
    const paymentAttrs = payment?.attributes ?? {};
    const lineItem = attrs.line_items?.[0] ?? {};

    return {
      paymentId: payment?.id,
      // Prefer what was actually charged; fall back to the line item so an
      // unexpectedly empty payments[] still records a plausible amount rather
      // than NULL.
      amountCentavos: paymentAttrs.amount ?? lineItem.amount,
      currency: paymentAttrs.currency ?? lineItem.currency,
      // Metadata is set on the session, not the payment.
      metadata: attrs.metadata ?? {},
      billingName: paymentAttrs.billing?.name ?? attrs.billing?.name,
      billingEmail: paymentAttrs.billing?.email ?? attrs.billing?.email ?? attrs.customer_email,
    };
  }

  // payment.paid — the resource already is the payment.
  return {
    paymentId: data.id,
    amountCentavos: attrs.amount,
    currency: attrs.currency,
    metadata: attrs.metadata ?? {},
    billingName: attrs.billing?.name,
    billingEmail: attrs.billing?.email,
  };
}

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

  const { paymentId, amountCentavos, currency, metadata, billingName, billingEmail } = normalize(
    eventType,
    paymentData,
  );

  // Two things are sold through this endpoint now: courses and facilitator
  // sessions. `kind` is set in the checkout session's metadata by whichever
  // flow created it.
  //
  // Its *absence* means a course order. That is not a fallback for tidiness —
  // `checkout.ts` writes no `kind` at all, so treating missing as 'product' is
  // what keeps course checkout working unchanged, including sessions already
  // in flight when this deployed.
  if (metadata.kind === 'booking') {
    return handleBooking(paymentId, metadata.booking_id, eventType);
  }

  const productId = metadata.product_id;
  const buyerEmail = metadata.buyer_email ?? billingEmail;

  if (!paymentId || !productId || !buyerEmail) {
    // Not necessarily a bug: for a hosted-checkout purchase the metadata lives
    // on the session, so the sibling `payment.paid` event legitimately arrives
    // without it and is expected to fall through to here — the
    // `checkout_session.payment.paid` event is the one that fulfills. Warn
    // rather than error so that normal case doesn't read as a failure, and
    // don't queue a retry: missing metadata never becomes present on redelivery.
    console.warn('[paymongo-webhook] event not mappable to a product/buyer, skipping', {
      eventType,
      paymentId,
      metadataKeys: Object.keys(metadata),
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
      amount_centavos: amountCentavos,
      currency: currency,
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
      const result = await fulfillOrder(order.id, billingName);
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

/**
 * Confirms a facilitator session that has just been paid for.
 *
 * Structurally simpler than the course path because the row already exists:
 * `POST /bookings` inserted it — holding the slot — before the buyer was ever
 * sent to PayMongo. So there is nothing to insert here and no dedupe to do
 * beyond what `confirmBooking` already handles, and "paid but not booked" is
 * not a reachable state.
 *
 * Shares the course path's contract with PayMongo: once the signature verifies,
 * always 200. Redelivering the same event would only re-run the same failing
 * code, so recovery belongs on the retry queue, not in PayMongo's backoff.
 */
async function handleBooking(
  paymentId: string | undefined,
  bookingId: string | undefined,
  eventType: string,
): Promise<APIGatewayProxyResultV2> {
  if (!bookingId) {
    // Expected for the sibling `payment.paid` event: metadata lives on the
    // checkout session, so only `checkout_session.payment.paid` carries it.
    // Missing metadata never becomes present on redelivery, so no retry.
    console.warn('[paymongo-webhook] booking event without booking_id, skipping', { eventType, paymentId });
    return ok({ received: true, handled: false, error: 'missing_booking_id' });
  }

  try {
    const result = await confirmBooking(bookingId, paymentId);
    return ok({ received: true, handled: true, status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[paymongo-webhook] booking confirmation failed, queuing retry', { bookingId, message });
    await enqueueRetry(bookingId, message, 'booking');
    return ok({ received: true, handled: true, status: 'queued_for_retry' });
  }
}

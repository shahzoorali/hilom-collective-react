/**
 * SQS consumer for the enrollment retry queue.
 *
 * Throwing on failure is the entire retry mechanism: a thrown error leaves
 * the message unacknowledged, SQS makes it visible again after the visibility
 * timeout, and it's retried up to the queue's maxReceiveCount before landing
 * on the dead-letter queue (which triggers the CloudWatch alarm -> SNS alert
 * wired up in CDK). No custom backoff/retry-count logic needed here — SQS
 * already provides it.
 */
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { fulfillOrder } from '../lib/fulfillment.js';
import { confirmBooking } from '../lib/booking-fulfillment.js';
import { applyChargePayment } from '../lib/registration-fulfillment.js';
import type { RetryKind } from '../lib/retry-queue.js';

interface RetryMessage {
  /** Absent on messages enqueued before bookings existed — those are orders. */
  kind?: RetryKind;
  /** The order id or the booking id, per `kind`. */
  orderId: string;
  reason: string;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let message: RetryMessage;
    try {
      message = JSON.parse(record.body) as RetryMessage;
    } catch {
      console.error('[enrollment-retry-consumer] malformed message body, dropping', record.body);
      continue; // Not retriable — a malformed message will never parse differently.
    }

    const kind = message.kind ?? 'order';

    try {
      if (kind === 'booking') {
        const result = await confirmBooking(message.orderId);
        console.log(`[enrollment-retry-consumer] booking ${message.orderId} -> ${result.status}`);
      } else if (kind === 'registration_charge') {
        // `orderId` carries the charge id — the field keeps its original name
        // for in-flight compatibility, as retry-queue.ts explains. No payment
        // id is passed: the webhook stamped it on the row before it failed,
        // which is exactly why applyChargePayment stamps it first.
        const result = await applyChargePayment(message.orderId);
        console.log(`[enrollment-retry-consumer] charge ${message.orderId} -> ${result.status}`);
      } else {
        const result = await fulfillOrder(message.orderId);
        console.log(`[enrollment-retry-consumer] order ${message.orderId} -> ${result.status}`);
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      console.error(`[enrollment-retry-consumer] ${kind} ${message.orderId} failed again: ${errMessage}`);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  // Partial batch failure: only the orders that failed go back on the queue,
  // not the whole batch — one stuck order shouldn't re-delay ones that
  // succeeded alongside it.
  return { batchItemFailures: failures };
}

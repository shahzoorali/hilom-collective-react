/**
 * POST /webhooks/paymongo
 *
 * Placeholder — Phase 6 implements signature verification, dedupe on
 * paymongo_payment_id, the order-first write, and the bundle-aware enrollment
 * loop.
 *
 * It returns 200 rather than 501 on purpose: PayMongo retries non-2xx responses
 * and will escalate to disabling the endpoint. Until the real handler exists,
 * acknowledging and logging is safer than accumulating failed deliveries.
 * Nothing is charged or fulfilled through this route yet, so acknowledging an
 * event here loses nothing.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok } from '../lib/http.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  console.warn('[paymongo-webhook] received event before Phase 6 implementation', {
    signature: event.headers['paymongo-signature'] ? 'present' : 'missing',
    bodyLength: event.body?.length ?? 0,
  });

  return ok({ received: true, implemented: false });
}

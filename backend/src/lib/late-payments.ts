/**
 * Money that arrives after its hold lapsed (0079).
 *
 * Every webhook path that can meet an expired hold calls `recordLatePayment`
 * once it knows the outcome. `revived` rows are a trail only; `needs_action`
 * rows are the admin queue and send one email — the insert is keyed on the
 * PayMongo payment id, so the two events PayMongo fires per payment, or a
 * retry, cannot alert twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendLatePaymentAlert } from './booking-email.js';

export type LatePaymentKind = 'booking' | 'class' | 'event_registration';

export interface LatePaymentInput {
  kind: LatePaymentKind;
  sourceId: string;
  paymentId: string | null | undefined;
  amountCentavos?: number | null;
  currency?: string | null;
  clientEmail?: string | null;
  outcome: 'revived' | 'needs_action';
  detail: string;
}

export async function recordLatePayment(supabase: SupabaseClient, input: LatePaymentInput): Promise<void> {
  // Without a payment id there is nothing to key on and nothing to refund
  // against; the sibling event without metadata ends up here.
  if (!input.paymentId) return;
  try {
    const { data, error } = await supabase
      .from('late_payments')
      .upsert(
        {
          kind: input.kind,
          source_id: input.sourceId,
          paymongo_payment_id: input.paymentId,
          amount_centavos: input.amountCentavos ?? null,
          currency: input.currency ?? 'PHP',
          client_email: input.clientEmail ?? null,
          outcome: input.outcome,
          detail: input.detail,
        },
        { onConflict: 'paymongo_payment_id', ignoreDuplicates: true },
      )
      .select('id');
    if (error) throw error;
    const inserted = (data ?? []).length > 0;
    console.warn('[late-payments] payment after hold expired', { ...input, inserted });
    if (inserted && input.outcome === 'needs_action') {
      await sendLatePaymentAlert({
        kind: input.kind,
        sourceId: input.sourceId,
        paymentId: input.paymentId,
        amountCentavos: input.amountCentavos ?? null,
        currency: input.currency ?? 'PHP',
        clientEmail: input.clientEmail ?? null,
        detail: input.detail,
      });
    }
  } catch (err) {
    // Logged loudly rather than thrown: the webhook must still 200, and the
    // payment itself is in PayMongo and in payment_ledger.
    console.error('[late-payments] could not record late payment', { input, err });
  }
}

/** Plain-English reason for a revive_* result other than 'revived'. */
export function reviveFailureReason(result: string): string {
  switch (result) {
    case 'full':
      return 'No place left: it filled up after the hold expired.';
    case 'session_unavailable':
      return 'The class session has started, finished or been cancelled.';
    case 'event_unavailable':
      return 'The event has started or is no longer published.';
    case 'not_found':
      return 'The held record no longer exists.';
    default:
      return `Could not re-claim the place (${result}).`;
  }
}

/**
 * Nightly finance job (EventBridge, not routed).
 *
 * Keeps payment_ledger converging on PayMongo: captures any referenced payment
 * the webhook capture missed, and refreshes rows PayMongo may still change —
 * no fee yet, or not yet in a payout. A row with a payout id is final and is
 * left alone.
 *
 * Reconciliation exceptions are not stored; they are recomputed whenever the
 * Finance pages are read, so there is nothing here to raise.
 */
import { getSupabase } from '../lib/supabase.js';
import { captureAndStorePayment, allReferencedPaymentIds } from '../lib/paymongo-ledger.js';

/** Stop starting new fetches after this, inside the 30 s function timeout. */
const TIME_BUDGET_MS = 22_000;

export async function handler(): Promise<{ checked: number; refreshed: number; failed: number }> {
  const supabase = await getSupabase();
  const referenced = await allReferencedPaymentIds(supabase);
  const { data, error } = await supabase.from('payment_ledger').select('paymongo_payment_id, fee_centavos, payout_id');
  if (error) throw error;
  const have = new Map(
    ((data ?? []) as { paymongo_payment_id: string; fee_centavos: number | null; payout_id: string | null }[]).map((r) => [r.paymongo_payment_id, r]),
  );
  const due = referenced.filter((id) => {
    const r = have.get(id);
    return !r || r.fee_centavos === null || !r.payout_id;
  });

  let refreshed = 0;
  let failed = 0;
  const started = Date.now();
  for (const id of due) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const res = await captureAndStorePayment(supabase, id);
    if (res.ok) refreshed += 1;
    else failed += 1;
  }
  console.log('[finance-sweep]', { due: due.length, refreshed, failed });
  return { checked: due.length, refreshed, failed };
}

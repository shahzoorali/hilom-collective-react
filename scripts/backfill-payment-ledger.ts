/**
 * Backfill payment_ledger (0070) from PayMongo for every payment our tables
 * reference.
 *
 *   PAYMONGO_SECRET_ID=hilom/paymongo/live npx tsx scripts/backfill-payment-ledger.ts           # dry run
 *   PAYMONGO_SECRET_ID=hilom/paymongo/live npx tsx scripts/backfill-payment-ledger.ts --apply   # write
 *   ... --apply --all     refetch rows that already have a fee too
 *
 * FINANCE_TEST_EMAILS=a@x.com,b@y.com marks small payments from those buyers as
 * tests. Needs AWS credentials for ap-southeast-1 (Supabase + PayMongo secrets).
 */
import { getSupabase } from '../backend/src/lib/supabase.js';
import { allReferencedPaymentIds, captureAndStorePayment } from '../backend/src/lib/paymongo-ledger.js';

const apply = process.argv.includes('--apply');
const all = process.argv.includes('--all');

if (!process.env.PAYMONGO_SECRET_ID) {
  console.error('Set PAYMONGO_SECRET_ID (hilom/paymongo/live for production data).');
  process.exit(1);
}

const supabase = await getSupabase();
const referenced = await allReferencedPaymentIds(supabase);
const { data, error } = await supabase.from('payment_ledger').select('paymongo_payment_id, fee_centavos');
if (error) throw error;
const withFee = new Set(((data ?? []) as { paymongo_payment_id: string; fee_centavos: number | null }[]).filter((r) => r.fee_centavos !== null).map((r) => r.paymongo_payment_id));
const due = all ? referenced : referenced.filter((id) => !withFee.has(id));

console.log(`${referenced.length} referenced payment(s); ${due.length} to fetch${apply ? '' : ' (dry run — pass --apply to write)'}`);
if (!apply) process.exit(0);

let okCount = 0;
for (const id of due) {
  const r = await captureAndStorePayment(supabase, id);
  if (r.ok) okCount += 1;
  console.log(r.ok ? `ok   ${id}  ${r.source}  fee=${r.feeCentavos}` : `FAIL ${id}  ${r.error}`);
}
console.log(`done: ${okCount}/${due.length} captured`);

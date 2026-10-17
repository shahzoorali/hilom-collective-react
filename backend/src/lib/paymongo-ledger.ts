/**
 * payment_ledger capture: what PayMongo actually charged for a payment.
 *
 * The webhook payload carries the amount but not the fee, so the fee, net,
 * method and payout are read from /v1/payments/{id} after the fact. That makes
 * this a snapshot of PayMongo's record rather than our own fact, which is why
 * `adminPayment` (handlers/orders.ts) proxies live instead of mirroring. The
 * ledger exists anyway because a P&L and a payout reconciliation need the
 * numbers in aggregate, and the nightly finance job refreshes any row PayMongo
 * may still change (no payout yet) so the copy converges on the source.
 *
 * Every entry point is best-effort from the webhook's point of view: a
 * PayMongo hiccup here must never affect fulfilment.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPayMongoSecret } from './secrets.js';
import { feeVatCentavos, looksLikeTestPayment } from './finance-domain.js';

export type LedgerSource =
  | 'orders'
  | 'registration_charges'
  | 'class_registrations'
  | 'bookings'
  | 'booking_packages'
  | 'unknown';

const SOURCE_TABLES: Exclude<LedgerSource, 'unknown'>[] = [
  'registration_charges',
  'class_registrations',
  'bookings',
  'booking_packages',
  'orders',
];

interface PayMongoPaymentAttrs {
  status?: string;
  amount?: number;
  fee?: number;
  net_amount?: number;
  paid_at?: number | null;
  source?: { type?: string } | null;
  payment_method_used?: string | null;
  payout?: string | { id?: string } | null;
  billing?: { name?: string | null; email?: string | null } | null;
  refunds?: { id: string; attributes?: { amount?: number; status?: string; created_at?: number }; amount?: number; status?: string; created_at?: number }[] | null;
  [k: string]: unknown;
}

export interface CaptureResult {
  paymentId: string;
  ok: boolean;
  source: LedgerSource;
  feeCentavos: number | null;
  error?: string;
}

/** Which of our tables a PayMongo payment belongs to. */
export async function resolveSource(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<{ table: LedgerSource; id: string | null }> {
  for (const table of SOURCE_TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .eq('paymongo_payment_id', paymentId)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (error) throw error;
    if (data) return { table, id: data.id };
  }
  return { table: 'unknown', id: null };
}

async function fetchPayment(paymentId: string): Promise<{ id: string; attributes: PayMongoPaymentAttrs }> {
  const { secretKey } = await getPayMongoSecret();
  const res = await fetch(`https://api.paymongo.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
    signal: AbortSignal.timeout(6000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id: string; attributes?: PayMongoPaymentAttrs };
    errors?: { detail?: string }[];
  };
  if (!res.ok || !body.data) {
    throw new Error(body.errors?.[0]?.detail ?? `PayMongo returned HTTP ${res.status}`);
  }
  return { id: body.data.id, attributes: body.data.attributes ?? {} };
}

function payoutIdOf(p: PayMongoPaymentAttrs['payout']): string | null {
  if (!p) return null;
  if (typeof p === 'string') return p;
  return p.id ?? null;
}

/**
 * Fetch one payment from PayMongo and upsert its ledger row (and refunds).
 * Never throws: failures are recorded on the row as `fetch_error` so the
 * nightly job can retry and the reconciliation page can show them.
 */
export async function captureAndStorePayment(
  supabase: SupabaseClient,
  paymentId: string,
  opts: { testEmails?: string[] } = {},
): Promise<CaptureResult> {
  let source: { table: LedgerSource; id: string | null } = { table: 'unknown', id: null };
  try {
    source = await resolveSource(supabase, paymentId);
    const { attributes: a } = await fetchPayment(paymentId);
    const fee = typeof a.fee === 'number' ? a.fee : null;
    const gross = typeof a.amount === 'number' ? a.amount : 0;

    // Keep a manual test flag an admin already set; only the heuristic is
    // recomputed on refresh.
    const { data: existing } = await supabase
      .from('payment_ledger')
      .select('is_test, test_reason')
      .eq('paymongo_payment_id', paymentId)
      .maybeSingle<{ is_test: boolean; test_reason: string | null }>();
    const heuristic = looksLikeTestPayment({
      grossCentavos: gross,
      name: a.billing?.name ?? null,
      email: a.billing?.email ?? null,
      testEmails: opts.testEmails ?? testEmailsFromEnv(),
    });
    const manual = existing?.test_reason?.startsWith('manual') ?? false;
    const isTest = manual ? existing!.is_test : heuristic !== null;

    const row = {
      paymongo_payment_id: paymentId,
      source_table: source.table,
      source_id: source.id,
      status: a.status ?? null,
      paid_at: a.paid_at ? new Date(a.paid_at * 1000).toISOString() : null,
      gross_centavos: gross,
      fee_centavos: fee,
      fee_vat_centavos: fee === null ? null : feeVatCentavos(fee),
      net_centavos: typeof a.net_amount === 'number' ? a.net_amount : null,
      method: a.source?.type ?? a.payment_method_used ?? null,
      payout_id: payoutIdOf(a.payout),
      is_test: isTest,
      test_reason: manual ? existing!.test_reason : heuristic,
      raw: a as unknown as Record<string, unknown>,
      fetch_error: null,
      fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('payment_ledger').upsert(row, { onConflict: 'paymongo_payment_id' });
    if (error) throw error;

    for (const r of a.refunds ?? []) {
      const ra = r.attributes ?? r;
      const { error: refundError } = await supabase.from('refund_ledger').upsert(
        {
          paymongo_refund_id: r.id,
          paymongo_payment_id: paymentId,
          amount_centavos: ra.amount ?? 0,
          status: ra.status ?? null,
          refunded_at: ra.created_at ? new Date(ra.created_at * 1000).toISOString() : null,
          raw: r as unknown as Record<string, unknown>,
        },
        { onConflict: 'paymongo_refund_id' },
      );
      if (refundError) throw refundError;
    }

    return { paymentId, ok: true, source: source.table, feeCentavos: fee };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the failure without clobbering good numbers from an earlier fetch.
    await supabase
      .from('payment_ledger')
      .upsert(
        { paymongo_payment_id: paymentId, source_table: source.table, source_id: source.id },
        { onConflict: 'paymongo_payment_id', ignoreDuplicates: true },
      )
      .then(() =>
        supabase
          .from('payment_ledger')
          .update({ fetch_error: message.slice(0, 500), updated_at: new Date().toISOString() })
          .eq('paymongo_payment_id', paymentId),
      )
      .then(
        () => undefined,
        () => undefined,
      );
    return { paymentId, ok: false, source: source.table, feeCentavos: null, error: message };
  }
}

/** Comma-separated admin/test buyer emails, so their small payments are tests. */
export function testEmailsFromEnv(): string[] {
  return (process.env.FINANCE_TEST_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Every real PayMongo payment id our tables reference. */
export async function allReferencedPaymentIds(supabase: SupabaseClient): Promise<string[]> {
  const ids = new Set<string>();
  for (const table of SOURCE_TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select('paymongo_payment_id')
      .like('paymongo_payment_id', 'pay_%');
    if (error) throw error;
    for (const r of (data ?? []) as { paymongo_payment_id: string }[]) ids.add(r.paymongo_payment_id);
  }
  return [...ids];
}

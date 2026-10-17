/**
 * Admin → Finance. Replaces the hand-kept Sales & P&L workbook.
 *
 * Routed as `/admin/finance/{proxy+}`; the sub-path is matched here.
 *
 *   GET  overview                       KPIs, 6-month trend, payables, exceptions
 *   GET  revenue        ?from&to&category&facilitator&status&tests   the sales register
 *   GET  revenue.csv    (same filters)
 *   GET  pnl            ?month=YYYY-MM&basis=accrual|cash
 *   GET  payables                        owed per facilitator + refunds queue
 *   GET  reconciliation ?all=1           exceptions + PayMongo payout groups
 *   POST reconciliation/ack             {key, note, undo?}
 *   POST ledger/refresh                 {paymentIds?: string[], missing?: true}
 *   PUT  ledger/{paymentId}/test        {is_test}
 *   GET|POST expenses ; PUT expenses/{id} ; POST expenses/receipt-url ; GET expenses/{id}/receipt
 *   GET|POST reimbursements ; PUT reimbursements/{id}
 *   GET|POST adjustments ; PUT adjustments/{id}   (void)
 *   GET|POST split-rules ; DELETE split-rules/{id} ; GET split-rules/{id}/preview ; POST split-rules/{id}/apply
 *   GET  periods ; POST periods/{month}/close ; POST periods/{month}/reopen
 *   GET|POST transactions ; PUT transactions/{id} (void) ; GET transactions/{id}/receipt   offline money (0071)
 *   GET|POST accounts ?account=id ; PUT accounts/{id} ; POST accounts/{id}/statement
 *
 * Everything derived is computed in lib/finance-domain.ts from rows loaded
 * here. The data set is small (hundreds of rows a month), so the handler
 * loads whole tables rather than pushing aggregation into Postgres; when that
 * stops being true the view is where to start aggregating.
 *
 * Every write is audited.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, notFound, unauthorized, serverError, json, isAdminCaller } from '../lib/http.js';
import { adminActorFromEvent, recordAudit, type AuditActor } from '../lib/audit.js';
import { csvResponse } from '../lib/csv.js';
import {
  buildPnl,
  detectExceptions,
  facilitatorPayables,
  manilaDate,
  manilaMonth,
  previousMonth,
  assertPeriodOpen,
  validateRuleInput,
  EXPENSE_CATEGORIES,
  type AdjustmentRow,
  type Basis,
  type ExpenseRow,
  type LedgerRow,
  type PaidPayoutRow,
  type Pnl,
  type RefundLine,
  type RevenueLine,
  type SplitRule,
} from '../lib/finance-domain.js';
import { captureAndStorePayment, allReferencedPaymentIds } from '../lib/paymongo-ledger.js';
import { loadEventSplitContext, splitForEventCharge, ruleForEvent, SPLIT_RULE_COLUMNS } from '../lib/finance-splits.js';
import {
  accountExceptions,
  accountMovements,
  balanceAt,
  facilitatorBalances,
  monthEndDay,
  offlineSaleLine,
  offlineSplit,
  validateTransactionInput,
  type Account,
  type FinanceTransaction,
  type StatementBalance,
} from '../lib/finance-accounts.js';

const s3 = new S3Client({});
const RECEIPTS_BUCKET = process.env.FINANCE_RECEIPTS_BUCKET ?? '';
const RECEIPT_PREFIX = 'finance-receipts/';
const RECEIPT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);

class InputError extends Error {}
const conflict = (message: string) => json(409, { error: message });

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new InputError('Request body is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** supabase-js caps a select at 1000 rows; page through. */
async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

interface Dataset {
  lines: RevenueLine[];
  refunds: RefundLine[];
  ledger: (LedgerRow & { method: string | null; payout_id: string | null; net_centavos: number | null; paid_at: string | null; test_reason: string | null })[];
  expenses: (ExpenseRow & { vat_centavos: number; payment_method: string | null; event_id: string | null; receipt_name: string | null; notes: string | null; created_at: string })[];
  adjustments: (AdjustmentRow & { link: string | null; created_by: string | null; created_at: string })[];
  payouts: (PaidPayoutRow & { gross_centavos: number; platform_fee_centavos: number; clawback_centavos: number; period_start: string; period_end: string; reference: string | null })[];
  periods: { period: string; status: string; snapshot: { accrual?: Pnl; cash?: Pnl } | null; closed_by: string | null; closed_at: string | null }[];
  facilitators: { id: string; display_name: string; platform_fee_bps: number }[];
  transactions: (FinanceTransaction & { payment_method: string | null; receipt_key: string | null; receipt_name: string | null; notes: string | null; void_reason: string | null; created_by: string | null })[];
  accounts: (Account & { notes: string | null })[];
  statements: (StatementBalance & { note: string | null; entered_by: string | null; entered_at: string })[];
  reimbursements: { id: string; payee: string; status: string; paid_at: string | null; account_id: string | null; reference: string | null }[];
}

async function loadDataset(supabase: SupabaseClient): Promise<Dataset> {
  const [rawLines, refunds, ledger, expenses, adjustments, payouts, periods, facilitators, transactions, accounts, statements, reimbursements] = await Promise.all([
    selectAll<Omit<RevenueLine, 'fee_centavos' | 'is_test'>>((a, b) =>
      supabase.from('v_revenue_lines').select('*').order('occurred_at', { ascending: false }).range(a, b),
    ),
    selectAll<RefundLine>((a, b) => supabase.from('v_refund_lines').select('*').range(a, b)),
    selectAll<Dataset['ledger'][number]>((a, b) =>
      supabase
        .from('payment_ledger')
        .select('paymongo_payment_id, source_table, gross_centavos, fee_centavos, net_centavos, fetch_error, is_test, test_reason, method, payout_id, paid_at')
        .range(a, b),
    ),
    selectAll<Dataset['expenses'][number]>((a, b) =>
      supabase.from('expenses').select('*').order('incurred_on', { ascending: false }).range(a, b),
    ),
    selectAll<Dataset['adjustments'][number]>((a, b) =>
      supabase.from('finance_adjustments').select('*').order('created_at', { ascending: false }).range(a, b),
    ),
    selectAll<Dataset['payouts'][number]>((a, b) =>
      supabase
        .from('facilitator_payouts')
        .select('id, facilitator_id, status, paid_at, gross_centavos, platform_fee_centavos, processing_fee_centavos, clawback_centavos, net_centavos, period_start, period_end, reference, account_id')
        .range(a, b),
    ),
    selectAll<Dataset['periods'][number]>((a, b) => supabase.from('finance_periods').select('*').range(a, b)),
    selectAll<Dataset['facilitators'][number]>((a, b) =>
      supabase.from('facilitators').select('id, display_name, platform_fee_bps').range(a, b),
    ),
    selectAll<Dataset['transactions'][number]>((a, b) =>
      supabase.from('finance_transactions').select('*').order('occurred_on', { ascending: false }).range(a, b),
    ),
    selectAll<Dataset['accounts'][number]>((a, b) => supabase.from('finance_accounts').select('*').order('created_at').range(a, b)),
    selectAll<Dataset['statements'][number]>((a, b) => supabase.from('finance_account_balances').select('*').range(a, b)),
    selectAll<Dataset['reimbursements'][number]>((a, b) =>
      supabase.from('reimbursements').select('id, payee, status, paid_at, account_id, reference').range(a, b),
    ),
  ]);

  const byPayment = new Map(ledger.map((r) => [r.paymongo_payment_id, r]));
  const lines: RevenueLine[] = rawLines.map((l) => {
    const led = l.paymongo_payment_id ? byPayment.get(l.paymongo_payment_id) : undefined;
    return { ...l, fee_centavos: led?.fee_centavos ?? null, is_test: led?.is_test ?? false };
  });
  // Offline sales join the register as ordinary lines (0071).
  for (const t of transactions) if (t.kind === 'offline_sale' && t.status === 'posted') lines.push(offlineSaleLine(t));
  return { lines, refunds, ledger, expenses, adjustments, payouts, periods, facilitators, transactions, accounts, statements, reimbursements };
}

function payoutStatusMap(d: Dataset): Map<string, string> {
  return new Map(d.payouts.map((p) => [p.id, p.status]));
}

function balancesFor(d: Dataset) {
  return facilitatorBalances(d.lines, d.refunds, payoutStatusMap(d), d.transactions);
}

function movementsFor(d: Dataset) {
  return accountMovements({
    accounts: d.accounts,
    transactions: d.transactions,
    expenses: d.expenses as unknown as (ExpenseRow & { account_id: string | null })[],
    reimbursements: d.reimbursements.map((r) => ({
      ...r,
      total_centavos: d.expenses.filter((e) => e.reimbursement_id === r.id && e.status !== 'void').reduce((s, e) => s + e.amount_centavos, 0),
    })),
    payouts: d.payouts as unknown as (PaidPayoutRow & { account_id: string | null })[],
    ledger: d.ledger,
  });
}

function closedMonths(d: Dataset): Set<string> {
  return new Set(d.periods.filter((p) => p.status === 'closed').map((p) => p.period.slice(0, 7)));
}

function pnlFor(d: Dataset, month: string, basis: Basis, includeTests = false): Pnl {
  return buildPnl({
    month,
    basis,
    lines: d.lines,
    refunds: d.refunds,
    expenses: d.expenses,
    adjustments: d.adjustments,
    payouts: d.payouts,
    includeTests,
  });
}

async function reimbursementsOwed(supabase: SupabaseClient, d: Dataset) {
  const { data, error } = await supabase.from('reimbursements').select('id, payee, status').eq('status', 'owed');
  if (error) throw error;
  return ((data ?? []) as { id: string; payee: string }[]).map((r) => ({
    id: r.id,
    payee: r.payee,
    total_centavos: d.expenses
      .filter((e) => e.reimbursement_id === r.id && e.status !== 'void')
      .reduce((s, e) => s + e.amount_centavos, 0),
  }));
}

async function exceptionsFor(supabase: SupabaseClient, d: Dataset, includeAcked: boolean) {
  const closed = d.periods
    .filter((p) => p.status === 'closed' && p.snapshot?.accrual)
    .map((p) => {
      const month = p.period.slice(0, 7);
      return { month, snapshotNet: p.snapshot!.accrual!.net_profit, currentNet: pnlFor(d, month, 'accrual').net_profit };
    });
  const all = detectExceptions({
    lines: d.lines,
    refunds: d.refunds,
    ledger: d.ledger,
    expenses: d.expenses,
    payoutStatus: payoutStatusMap(d),
    closedPeriods: closed,
    reimbursementsOwed: await reimbursementsOwed(supabase, d),
    today: manilaDate(new Date()),
  });
  const names = new Map(d.facilitators.map((f) => [f.id, f.display_name]));
  all.push(...accountExceptions(d.accounts, movementsFor(d), d.statements, balancesFor(d), (id) => names.get(id) ?? 'A facilitator'));
  const { data: acks, error } = await supabase.from('finance_exception_acks').select('key, note, acked_by, acked_at');
  if (error) throw error;
  const ackByKey = new Map(((acks ?? []) as { key: string; note: string | null; acked_by: string | null; acked_at: string }[]).map((a) => [a.key, a]));
  const decorated = all.map((e) => ({ ...e, ack: ackByKey.get(e.key) ?? null }));
  return includeAcked ? decorated : decorated.filter((e) => !e.ack);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path.replace(/^.*\/admin\/finance\/?/, '').replace(/\/$/, '');
  const seg = path.split('/').map((s) => decodeURIComponent(s));
  const q = event.queryStringParameters ?? {};

  try {
    const supabase = await getSupabase();
    const actor = await adminActorFromEvent(event);

    switch (seg[0]) {
      case 'overview':
        if (method === 'GET') return await overview(supabase);
        break;
      case 'revenue':
        if (method === 'GET') return await revenue(supabase, q, false);
        break;
      case 'revenue.csv':
        if (method === 'GET') return await revenue(supabase, q, true);
        break;
      case 'pnl':
        if (method === 'GET') return await pnl(supabase, q);
        break;
      case 'payables':
        if (method === 'GET') return await payables(supabase);
        break;
      case 'reconciliation':
        if (method === 'GET' && !seg[1]) return await reconciliation(supabase, q.all === '1');
        if (method === 'POST' && seg[1] === 'ack') return await ack(supabase, parseBody(event), actor);
        break;
      case 'ledger':
        if (method === 'POST' && seg[1] === 'refresh') return await refreshLedger(supabase, parseBody(event), actor);
        if (method === 'PUT' && seg[1] && seg[2] === 'test') return await setTest(supabase, seg[1], parseBody(event), actor);
        break;
      case 'expenses':
        if (method === 'GET' && !seg[1]) return await listExpenses(supabase);
        if (method === 'POST' && !seg[1]) return await saveExpense(supabase, null, parseBody(event), actor);
        if (method === 'POST' && seg[1] === 'receipt-url') return await receiptUploadUrl(parseBody(event));
        if (method === 'PUT' && seg[1]) return await saveExpense(supabase, seg[1], parseBody(event), actor);
        if (method === 'GET' && seg[1] && seg[2] === 'receipt') return await receiptUrlFor(supabase, 'expenses', seg[1]);
        break;
      case 'reimbursements':
        if (method === 'GET' && !seg[1]) return await listReimbursements(supabase);
        if (method === 'POST' && !seg[1]) return await createReimbursement(supabase, parseBody(event), actor);
        if (method === 'PUT' && seg[1]) return await updateReimbursement(supabase, seg[1], parseBody(event), actor);
        break;
      case 'adjustments':
        if (method === 'GET' && !seg[1]) return await listAdjustments(supabase);
        if (method === 'POST' && !seg[1]) return await createAdjustment(supabase, parseBody(event), actor);
        if (method === 'PUT' && seg[1]) return await voidAdjustment(supabase, seg[1], parseBody(event), actor);
        break;
      case 'split-rules':
        if (method === 'GET' && !seg[1]) return await listRules(supabase);
        if (method === 'POST' && !seg[1]) return await createRule(supabase, parseBody(event), actor);
        if (method === 'DELETE' && seg[1]) return await voidRule(supabase, seg[1], actor);
        if (method === 'GET' && seg[1] && seg[2] === 'preview') return await applyRule(supabase, seg[1], actor, true);
        if (method === 'POST' && seg[1] && seg[2] === 'apply') return await applyRule(supabase, seg[1], actor, false);
        break;
      case 'transactions':
        if (method === 'GET' && !seg[1]) return await listTransactions(supabase);
        if (method === 'POST' && !seg[1]) return await createTransaction(supabase, parseBody(event), actor);
        if (method === 'PUT' && seg[1] && !seg[2]) return await voidTransaction(supabase, seg[1], parseBody(event), actor);
        if (method === 'GET' && seg[1] && seg[2] === 'receipt') return await receiptUrlFor(supabase, 'finance_transactions', seg[1]);
        break;
      case 'accounts':
        if (method === 'GET' && !seg[1]) return await listAccounts(supabase, q);
        if (method === 'POST' && !seg[1]) return await saveAccount(supabase, null, parseBody(event), actor);
        if (method === 'PUT' && seg[1] && !seg[2]) return await saveAccount(supabase, seg[1], parseBody(event), actor);
        if (method === 'POST' && seg[1] && seg[2] === 'statement') return await saveStatement(supabase, seg[1], parseBody(event), actor);
        break;
      case 'periods':
        if (method === 'GET' && !seg[1]) return await listPeriods(supabase);
        if (method === 'POST' && seg[1] && seg[2] === 'close') return await closePeriod(supabase, seg[1], actor);
        if (method === 'POST' && seg[1] && seg[2] === 'reopen') return await reopenPeriod(supabase, seg[1], parseBody(event), actor);
        break;
    }
    return notFound(`No finance route for ${method} /${path}`);
  } catch (err) {
    if (err instanceof InputError) return badRequest(err.message);
    return serverError('adminFinance', err);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function lastMonths(n: number): string[] {
  const out: string[] = [];
  let m = manilaMonth(new Date());
  for (let i = 0; i < n; i++) {
    out.unshift(m);
    m = previousMonth(m);
  }
  return out;
}

async function overview(supabase: SupabaseClient) {
  const d = await loadDataset(supabase);
  const months = lastMonths(6);
  const trend = months.map((m) => {
    const p = pnlFor(d, m, 'accrual');
    return { month: m, gross_sales: p.gross_sales, net_revenue: p.net_revenue, net_profit: p.net_profit, opex: p.opex_total };
  });
  const current = months[months.length - 1]!;
  const payables = balancesFor(d);
  const exceptions = await exceptionsFor(supabase, d, false);
  const movements = movementsFor(d);
  const today = manilaDate(new Date());
  const refundsOwed = d.refunds.filter((r) => !r.refunded_at);
  const ledgerUnpaidOut = d.ledger.filter((r) => !r.is_test && r.net_centavos !== null && !r.payout_id);

  return ok({
    generatedAt: new Date().toISOString(),
    currency: 'PHP',
    month: current,
    current: pnlFor(d, current, 'accrual'),
    previous: pnlFor(d, previousMonth(current), 'accrual'),
    trend,
    kpis: {
      facilitator_owed_centavos: payables.reduce((s, p) => s + Math.max(0, p.net_owed_centavos), 0),
      cash_on_hand_centavos: d.accounts.filter((a) => a.is_active).reduce((s, a) => s + balanceAt(a, movements, today), 0),
      accounts_count: d.accounts.filter((a) => a.is_active).length,
      clawback_due_centavos: payables.reduce((s, p) => s + p.clawback_due_centavos, 0),
      refunds_owed_centavos: refundsOwed.reduce((s, r) => s + r.refund_centavos, 0),
      refunds_owed_count: refundsOwed.length,
      paymongo_pending_payout_centavos: ledgerUnpaidOut.reduce((s, r) => s + (r.net_centavos ?? 0), 0),
      ledger_coverage: {
        payments: d.lines.filter((l) => l.paymongo_payment_id?.startsWith('pay_')).length,
        with_fee: d.lines.filter((l) => l.paymongo_payment_id?.startsWith('pay_') && l.fee_centavos !== null).length,
      },
    },
    exceptions: {
      total: exceptions.length,
      high: exceptions.filter((e) => e.severity === 'high').length,
      top: exceptions.slice(0, 6),
    },
  });
}

function filterLines(d: Dataset, q: Record<string, string | undefined>): RevenueLine[] {
  const from = q.from ?? null; // YYYY-MM-DD, Manila, inclusive
  const to = q.to ?? null;
  const basis: Basis = q.basis === 'accrual' ? 'accrual' : 'cash';
  const refunded = new Set(d.refunds.map((r) => `${r.source}:${r.source_id}`));
  const refundSource: Record<string, string> = { registration_charges: 'event_registrations' };
  return d.lines.filter((l) => {
    const day = manilaDate(basis === 'accrual' ? l.service_date : l.occurred_at);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (q.category && l.category !== q.category) return false;
    if (q.facilitator && (q.facilitator === 'none' ? l.facilitator_id !== null : l.facilitator_id !== q.facilitator)) return false;
    if (q.tests !== '1' && l.is_test) return false;
    const isRefunded = refunded.has(`${refundSource[l.source] ?? l.source}:${l.parent_id}`);
    if (q.status === 'refunded' && !isRefunded) return false;
    if (q.status === 'paid' && isRefunded) return false;
    if (q.status === 'split_missing' && !l.split_missing) return false;
    if (q.search) {
      const s = q.search.toLowerCase();
      if (![l.buyer_name, l.buyer_email, l.item].some((v) => v?.toLowerCase().includes(s))) return false;
    }
    return true;
  });
}

async function revenue(supabase: SupabaseClient, q: Record<string, string | undefined>, csv: boolean) {
  const d = await loadDataset(supabase);
  const lines = filterLines(d, q);
  const names = new Map(d.facilitators.map((f) => [f.id, f.display_name]));
  const refunds = new Map<string, RefundLine>();
  for (const r of d.refunds) refunds.set(`${r.source}:${r.source_id}`, r);
  const refundSource: Record<string, string> = { registration_charges: 'event_registrations' };
  const ledger = new Map(d.ledger.map((r) => [r.paymongo_payment_id, r]));
  const payouts = payoutStatusMap(d);

  const rows = lines.map((l) => {
    const r = refunds.get(`${refundSource[l.source] ?? l.source}:${l.parent_id}`) ?? null;
    const led = l.paymongo_payment_id ? ledger.get(l.paymongo_payment_id) : undefined;
    return {
      ...l,
      facilitator_name: l.facilitator_id ? names.get(l.facilitator_id) ?? null : null,
      method: led?.method ?? null,
      net_centavos: led?.net_centavos ?? null,
      paymongo_payout_id: led?.payout_id ?? null,
      test_reason: led?.test_reason ?? null,
      refund: r ? { centavos: r.refund_centavos, sent_at: r.refunded_at } : null,
      payout_status: l.payout_id ? payouts.get(l.payout_id) ?? null : null,
    };
  });

  if (csv) {
    return csvResponse(
      `hilom-sales-${q.from ?? 'all'}-${q.to ?? 'now'}.csv`,
      [
        'Paid at (Manila)', 'Service date', 'Buyer', 'Email', 'Item', 'Category', 'Facilitator',
        'Gross', 'PayMongo fee', 'Method', 'Hilom share', 'Facilitator share', 'Refund', 'Refund sent',
        'Payout status', 'PayMongo payment', 'PayMongo payout', 'Test', 'Source', 'Source id',
      ],
      rows.map((r) => [
        manilaDate(r.occurred_at) + ' ' + new Date(Date.parse(r.occurred_at) + 8 * 3600e3).toISOString().slice(11, 16),
        manilaDate(r.service_date),
        r.buyer_name, r.buyer_email, r.item, r.category, r.facilitator_name,
        (r.gross_centavos / 100).toFixed(2),
        r.fee_centavos === null ? '' : (r.fee_centavos / 100).toFixed(2),
        r.method,
        (r.hilom_share_centavos / 100).toFixed(2),
        (r.facilitator_share_centavos / 100).toFixed(2),
        r.refund ? (r.refund.centavos / 100).toFixed(2) : '',
        r.refund?.sent_at ? manilaDate(r.refund.sent_at) : r.refund ? 'NOT SENT' : '',
        r.payout_status, r.paymongo_payment_id, r.paymongo_payout_id, r.is_test ? 'yes' : '', r.source, r.source_id,
      ]),
    );
  }

  const sum = (f: (l: RevenueLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  return ok({
    rows: rows.slice(0, 2000),
    truncated: rows.length > 2000,
    totals: {
      count: lines.length,
      gross_centavos: sum((l) => l.gross_centavos),
      fee_centavos: sum((l) => l.fee_centavos ?? 0),
      hilom_share_centavos: sum((l) => l.hilom_share_centavos),
      facilitator_share_centavos: sum((l) => l.facilitator_share_centavos),
    },
    categories: [...new Set(d.lines.map((l) => l.category))].sort(),
    facilitators: d.facilitators.map((f) => ({ id: f.id, name: f.display_name })),
  });
}

async function pnl(supabase: SupabaseClient, q: Record<string, string | undefined>) {
  const month = q.month ?? manilaMonth(new Date());
  if (!/^\d{4}-\d{2}$/.test(month)) return badRequest('month must be YYYY-MM');
  const basis: Basis = q.basis === 'cash' ? 'cash' : 'accrual';
  const d = await loadDataset(supabase);
  const period = d.periods.find((p) => p.period.slice(0, 7) === month) ?? null;
  return ok({
    pnl: pnlFor(d, month, basis, q.tests === '1'),
    previous: pnlFor(d, previousMonth(month), basis, q.tests === '1'),
    period: period ? { status: period.status, closed_by: period.closed_by, closed_at: period.closed_at, snapshot: period.snapshot?.[basis] ?? null } : { status: 'open' },
    adjustments: d.adjustments.filter((a) => a.period.slice(0, 7) === month),
  });
}

async function payables(supabase: SupabaseClient) {
  const d = await loadDataset(supabase);
  const names = new Map(d.facilitators.map((f) => [f.id, f]));
  const rows = balancesFor(d).map((p) => ({
    ...p,
    name: names.get(p.facilitator_id)?.display_name ?? 'Unknown facilitator',
    platform_fee_bps: names.get(p.facilitator_id)?.platform_fee_bps ?? null,
    paid_total_centavos: d.payouts
      .filter((x) => x.facilitator_id === p.facilitator_id && x.status === 'paid')
      .reduce((s, x) => s + x.net_centavos, 0),
    last_paid_at: d.payouts
      .filter((x) => x.facilitator_id === p.facilitator_id && x.status === 'paid' && x.paid_at)
      .map((x) => x.paid_at!)
      .sort()
      .pop() ?? null,
  }));
  return ok({
    facilitators: rows.sort((a, b) => b.net_owed_centavos - a.net_owed_centavos),
    offline_payments: d.transactions
      .filter((t) => t.kind === 'facilitator_payment' && t.status === 'posted')
      .map((t) => ({ ...t, facilitator_name: t.facilitator_id ? names.get(t.facilitator_id)?.display_name ?? null : null })),
    refunds: d.refunds
      .map((r) => ({ ...r, facilitator_name: r.facilitator_id ? names.get(r.facilitator_id)?.display_name ?? null : null }))
      .sort((a, b) => (a.refunded_at ? 1 : 0) - (b.refunded_at ? 1 : 0) || Date.parse(b.decided_at) - Date.parse(a.decided_at)),
    payouts: d.payouts
      .map((p) => ({ ...p, facilitator_name: names.get(p.facilitator_id)?.display_name ?? null }))
      .sort((a, b) => Date.parse(b.period_end) - Date.parse(a.period_end)),
  });
}

async function reconciliation(supabase: SupabaseClient, all: boolean) {
  const d = await loadDataset(supabase);
  const exceptions = await exceptionsFor(supabase, d, all);
  // Group the ledger by PayMongo payout: what each bank deposit should contain.
  const groups = new Map<string, { payout_id: string | null; count: number; gross: number; fees: number; net: number; first: string | null; last: string | null }>();
  for (const r of d.ledger) {
    if (r.is_test) continue;
    const k = r.payout_id ?? 'pending';
    const g = groups.get(k) ?? { payout_id: r.payout_id, count: 0, gross: 0, fees: 0, net: 0, first: null, last: null };
    g.count += 1;
    g.gross += r.gross_centavos;
    g.fees += r.fee_centavos ?? 0;
    g.net += r.net_centavos ?? 0;
    if (r.paid_at) {
      if (!g.first || r.paid_at < g.first) g.first = r.paid_at;
      if (!g.last || r.paid_at > g.last) g.last = r.paid_at;
    }
    groups.set(k, g);
  }
  return ok({
    exceptions,
    payout_groups: [...groups.values()].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? '')),
    ledger: {
      rows: d.ledger.length,
      missing_fee: d.ledger.filter((r) => r.fee_centavos === null).length,
      errors: d.ledger.filter((r) => r.fetch_error).length,
      tests: d.ledger.filter((r) => r.is_test).length,
    },
  });
}

// ---------------------------------------------------------------------------
// Ledger & reconciliation writes
// ---------------------------------------------------------------------------

async function ack(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  const key = typeof b.key === 'string' ? b.key : '';
  if (!key) return badRequest('key is required');
  if (b.undo === true) {
    const { error } = await supabase.from('finance_exception_acks').delete().eq('key', key);
    if (error) throw error;
  } else {
    const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : null;
    const { error } = await supabase
      .from('finance_exception_acks')
      .upsert({ key, note, acked_by: actor.label, acked_at: new Date().toISOString() });
    if (error) throw error;
  }
  await recordAudit(actor, { action: b.undo ? 'finance.exception.unack' : 'finance.exception.ack', targetTable: 'finance_exception_acks', targetId: null, note: key });
  return ok({ ok: true });
}

async function refreshLedger(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  let ids: string[];
  if (Array.isArray(b.paymentIds)) {
    ids = b.paymentIds.filter((x): x is string => typeof x === 'string' && x.startsWith('pay_'));
  } else {
    const referenced = await allReferencedPaymentIds(supabase);
    const { data, error } = await supabase.from('payment_ledger').select('paymongo_payment_id, fee_centavos, payout_id');
    if (error) throw error;
    const have = new Map(((data ?? []) as { paymongo_payment_id: string; fee_centavos: number | null; payout_id: string | null }[]).map((r) => [r.paymongo_payment_id, r]));
    ids = referenced.filter((id) => {
      const r = have.get(id);
      return !r || r.fee_centavos === null || (b.missing !== true && !r.payout_id);
    });
  }
  // Bounded per request so the call finishes inside API Gateway's 30s; the
  // page calls again while `remaining` is non-zero.
  const started = Date.now();
  const results = [];
  for (const id of ids) {
    if (Date.now() - started > 18_000) break;
    results.push(await captureAndStorePayment(supabase, id));
  }
  const batch = results;
  await recordAudit(actor, { action: 'finance.ledger.refresh', targetTable: 'payment_ledger', note: `${batch.length} payment(s)` });
  return ok({
    refreshed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => ({ id: r.paymentId, error: r.error })),
    remaining: ids.length - batch.length,
  });
}

async function setTest(supabase: SupabaseClient, paymentId: string, b: Record<string, unknown>, actor: AuditActor) {
  const isTest = b.is_test === true;
  const { data, error } = await supabase
    .from('payment_ledger')
    .update({ is_test: isTest, test_reason: `manual: ${actor.label}`, updated_at: new Date().toISOString() })
    .eq('paymongo_payment_id', paymentId)
    .select('paymongo_payment_id, gross_centavos')
    .maybeSingle<{ paymongo_payment_id: string; gross_centavos: number }>();
  if (error) throw error;
  if (!data) return notFound('That payment is not in the ledger yet — refresh it from PayMongo first.');
  await recordAudit(actor, {
    action: isTest ? 'finance.payment.mark_test' : 'finance.payment.unmark_test',
    targetTable: 'payment_ledger',
    targetId: null,
    amountCentavos: data.gross_centavos,
    currency: 'PHP',
    note: paymentId,
  });
  return ok({ ok: true });
}

// ---------------------------------------------------------------------------
// Expenses & receipts
// ---------------------------------------------------------------------------

async function closedSet(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('finance_periods').select('period').eq('status', 'closed');
  if (error) throw error;
  return new Set(((data ?? []) as { period: string }[]).map((p) => p.period.slice(0, 7)));
}

async function listExpenses(supabase: SupabaseClient) {
  const [{ data, error }, { data: events, error: evError }] = await Promise.all([
    supabase.from('expenses').select('*').order('incurred_on', { ascending: false }),
    supabase.from('events').select('id, title, starts_at').order('starts_at', { ascending: false }).limit(300),
  ]);
  if (error) throw error;
  if (evError) throw evError;
  return ok({ expenses: data ?? [], categories: EXPENSE_CATEGORIES, events: events ?? [] });
}

function centavos(v: unknown, field: string, allowZero = false): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) throw new InputError(`${field} must be a whole, positive number of centavos`);
  return n;
}

async function saveExpense(supabase: SupabaseClient, id: string | null, b: Record<string, unknown>, actor: AuditActor) {
  let before: Record<string, unknown> | null = null;
  if (id) {
    const { data, error } = await supabase.from('expenses').select('*').eq('id', id).maybeSingle<Record<string, unknown>>();
    if (error) throw error;
    if (!data) return notFound('Expense not found');
    before = data;
  }
  const merged = { ...(before ?? {}), ...b } as Record<string, unknown>;
  const incurredOn = String(merged.incurred_on ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incurredOn)) return badRequest('incurred_on must be YYYY-MM-DD');
  if (!EXPENSE_CATEGORIES.includes(merged.category as (typeof EXPENSE_CATEGORIES)[number])) return badRequest('category is not recognised');
  if (typeof merged.vendor !== 'string' || !merged.vendor.trim()) return badRequest('vendor is required');
  const status = String(merged.status ?? 'approved');
  if (!['draft', 'approved', 'void'].includes(status)) return badRequest('status must be draft, approved or void');

  const closed = await closedSet(supabase);
  const lock = assertPeriodOpen(incurredOn.slice(0, 7), closed) ??
    (before ? assertPeriodOpen(String(before.incurred_on).slice(0, 7), closed) : null);
  if (lock) return conflict(lock);

  const receiptKey = merged.receipt_key ?? null;
  if (receiptKey !== null && (typeof receiptKey !== 'string' || !receiptKey.startsWith(RECEIPT_PREFIX))) {
    return badRequest('receipt_key is not a finance receipt');
  }

  const row = {
    incurred_on: incurredOn,
    vendor: String(merged.vendor).trim().slice(0, 200),
    description: String(merged.description ?? '').slice(0, 1000),
    category: merged.category,
    amount_centavos: centavos(merged.amount_centavos, 'amount_centavos'),
    vat_centavos: centavos(merged.vat_centavos ?? 0, 'vat_centavos', true),
    paid_by: String(merged.paid_by ?? 'company').trim().slice(0, 100) || 'company',
    payment_method: merged.payment_method ? String(merged.payment_method).slice(0, 100) : null,
    event_id: typeof merged.event_id === 'string' && merged.event_id ? merged.event_id : null,
    receipt_key: receiptKey,
    receipt_name: merged.receipt_name ? String(merged.receipt_name).slice(0, 200) : null,
    status,
    notes: merged.notes ? String(merged.notes).slice(0, 2000) : null,
    // Which account paid it. Null for a personally paid expense: that money
    // leaves an account when the reimbursement is paid, not now.
    account_id: typeof merged.account_id === 'string' && merged.account_id ? merged.account_id : null,
    updated_at: new Date().toISOString(),
  };

  const query = id
    ? supabase.from('expenses').update(row).eq('id', id)
    : supabase.from('expenses').insert({ ...row, created_by: actor.label });
  const { data, error } = await query.select('*').single<Record<string, unknown>>();
  if (error) throw error;

  // Paid personally → it is owed back. Attach to the payee's open
  // reimbursement, creating one if needed, unless the admin linked one.
  if (row.paid_by.toLowerCase() !== 'company' && row.status !== 'void' && !data.reimbursement_id) {
    const reimbursementId = await openReimbursementFor(supabase, row.paid_by, actor);
    await supabase.from('expenses').update({ reimbursement_id: reimbursementId }).eq('id', data.id as string);
    data.reimbursement_id = reimbursementId;
  }

  await recordAudit(actor, {
    action: id ? 'finance.expense.update' : 'finance.expense.create',
    targetTable: 'expenses',
    targetId: data.id as string,
    amountCentavos: row.amount_centavos,
    currency: 'PHP',
    before,
    after: data,
  });
  return ok({ expense: data });
}

async function openReimbursementFor(supabase: SupabaseClient, payee: string, actor: AuditActor): Promise<string> {
  const { data, error } = await supabase
    .from('reimbursements')
    .select('id')
    .eq('status', 'owed')
    .ilike('payee', payee)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  if (data) return data.id;
  const { data: created, error: createError } = await supabase
    .from('reimbursements')
    .insert({ payee, created_by: actor.label })
    .select('id')
    .single<{ id: string }>();
  if (createError) throw createError;
  return created.id;
}

async function receiptUploadUrl(b: Record<string, unknown>) {
  if (!RECEIPTS_BUCKET) return serverError('adminFinance.receipt', new Error('FINANCE_RECEIPTS_BUCKET is not configured'));
  const contentType = String(b.contentType ?? '');
  if (!RECEIPT_TYPES.has(contentType)) return badRequest('Receipts must be a PDF or an image');
  const name = String(b.filename ?? 'receipt').replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'receipt';
  const key = `${RECEIPT_PREFIX}${manilaMonth(new Date())}/${randomUUID()}-${name}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: RECEIPTS_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  return ok({ uploadUrl, key, name });
}

async function receiptUrlFor(supabase: SupabaseClient, table: 'expenses' | 'finance_transactions', id: string) {
  const { data, error } = await supabase.from(table).select('receipt_key, receipt_name').eq('id', id).maybeSingle<{ receipt_key: string | null; receipt_name: string | null }>();
  if (error) throw error;
  if (!data?.receipt_key) return notFound('No receipt on this record');
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: RECEIPTS_BUCKET,
      Key: data.receipt_key,
      ResponseContentDisposition: `inline; filename="${(data.receipt_name ?? 'receipt').replace(/"/g, '')}"`,
    }),
    { expiresIn: 300 },
  );
  return ok({ url });
}

// ---------------------------------------------------------------------------
// Reimbursements
// ---------------------------------------------------------------------------

async function listReimbursements(supabase: SupabaseClient) {
  const [{ data, error }, { data: exp, error: expError }] = await Promise.all([
    supabase.from('reimbursements').select('*').order('created_at', { ascending: false }),
    supabase.from('expenses').select('id, reimbursement_id, amount_centavos, status, vendor, incurred_on').not('reimbursement_id', 'is', null),
  ]);
  if (error) throw error;
  if (expError) throw expError;
  const expenses = (exp ?? []) as { id: string; reimbursement_id: string; amount_centavos: number; status: string; vendor: string; incurred_on: string }[];
  return ok({
    reimbursements: ((data ?? []) as { id: string }[]).map((r) => {
      const items = expenses.filter((e) => e.reimbursement_id === r.id && e.status !== 'void');
      return { ...r, total_centavos: items.reduce((s, e) => s + e.amount_centavos, 0), expenses: items };
    }),
  });
}

async function createReimbursement(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  const payee = typeof b.payee === 'string' ? b.payee.trim() : '';
  if (!payee) return badRequest('payee is required');
  const id = await openReimbursementFor(supabase, payee, actor);
  await recordAudit(actor, { action: 'finance.reimbursement.create', targetTable: 'reimbursements', targetId: id, note: payee });
  return ok({ id });
}

async function updateReimbursement(supabase: SupabaseClient, id: string, b: Record<string, unknown>, actor: AuditActor) {
  const status = String(b.status ?? '');
  if (!['owed', 'paid', 'void'].includes(status)) return badRequest('status must be owed, paid or void');
  const reference = typeof b.reference === 'string' ? b.reference.trim().slice(0, 200) : null;
  if (status === 'paid' && !reference) return badRequest('A reference (bank transfer id, GCash ref) is required to mark a reimbursement paid');
  const { data: before, error: readError } = await supabase.from('reimbursements').select('*').eq('id', id).maybeSingle<Record<string, unknown>>();
  if (readError) throw readError;
  if (!before) return notFound('Reimbursement not found');
  const { data, error } = await supabase
    .from('reimbursements')
    .update({
      status,
      reference: reference ?? before.reference,
      paid_at: status === 'paid' ? new Date().toISOString() : null,
      note: typeof b.note === 'string' ? b.note.slice(0, 1000) : before.note,
      account_id: typeof b.account_id === 'string' && b.account_id ? b.account_id : (before.account_id ?? null),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  const { data: exp } = await supabase.from('expenses').select('amount_centavos, status').eq('reimbursement_id', id);
  const total = ((exp ?? []) as { amount_centavos: number; status: string }[]).filter((e) => e.status !== 'void').reduce((s, e) => s + e.amount_centavos, 0);
  await recordAudit(actor, {
    action: `finance.reimbursement.${status}`,
    targetTable: 'reimbursements',
    targetId: id,
    amountCentavos: total,
    currency: 'PHP',
    before,
    after: data,
  });
  return ok({ reimbursement: data });
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

async function listAdjustments(supabase: SupabaseClient) {
  const { data, error } = await supabase.from('finance_adjustments').select('*').order('period', { ascending: false });
  if (error) throw error;
  return ok({ adjustments: data ?? [] });
}

async function createAdjustment(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  const month = String(b.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) return badRequest('month must be YYYY-MM');
  const line = String(b.line ?? '');
  if (!['revenue', 'payment_costs', 'opex', 'other'].includes(line)) return badRequest('line must be revenue, payment_costs, opex or other');
  const amount = Number(b.amount_centavos);
  if (!Number.isInteger(amount) || amount === 0) return badRequest('amount_centavos must be a non-zero whole number (negative is a cost)');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 5) return badRequest('A reason is required');
  const lock = assertPeriodOpen(month, await closedSet(supabase));
  if (lock) return conflict(lock);
  const { data, error } = await supabase
    .from('finance_adjustments')
    .insert({ period: `${month}-01`, line, amount_centavos: amount, reason: reason.slice(0, 1000), link: b.link ? String(b.link).slice(0, 500) : null, created_by: actor.label })
    .select('*')
    .single<{ id: string }>();
  if (error) throw error;
  await recordAudit(actor, { action: 'finance.adjustment.create', targetTable: 'finance_adjustments', targetId: data.id, amountCentavos: amount, currency: 'PHP', after: data, note: reason });
  return ok({ adjustment: data });
}

async function voidAdjustment(supabase: SupabaseClient, id: string, b: Record<string, unknown>, actor: AuditActor) {
  if (b.void !== true) return badRequest('Adjustments are immutable; send {"void": true} to void one');
  const { data: before, error: readError } = await supabase.from('finance_adjustments').select('*').eq('id', id).maybeSingle<{ period: string; amount_centavos: number }>();
  if (readError) throw readError;
  if (!before) return notFound('Adjustment not found');
  const lock = assertPeriodOpen(before.period.slice(0, 7), await closedSet(supabase));
  if (lock) return conflict(lock);
  const { error } = await supabase.from('finance_adjustments').update({ voided_at: new Date().toISOString() }).eq('id', id).is('voided_at', null);
  if (error) throw error;
  await recordAudit(actor, { action: 'finance.adjustment.void', targetTable: 'finance_adjustments', targetId: id, amountCentavos: before.amount_centavos, currency: 'PHP', before });
  return ok({ ok: true });
}

// ---------------------------------------------------------------------------
// Split rules
// ---------------------------------------------------------------------------

async function listRules(supabase: SupabaseClient) {
  const [rules, events, series, facilitators] = await Promise.all([
    supabase.from('revenue_split_rules').select('*').order('created_at', { ascending: false }),
    supabase.from('events').select('id, title, starts_at, facilitator_id, series_id, platform_fee_bps, finance_category').not('facilitator_id', 'is', null).order('starts_at', { ascending: false }),
    supabase.from('event_series').select('id, title'),
    supabase.from('facilitators').select('id, display_name, platform_fee_bps, default_event_platform_fee_bps'),
  ]);
  for (const r of [rules, events, series, facilitators]) if (r.error) throw r.error;
  return ok({ rules: rules.data ?? [], events: events.data ?? [], series: series.data ?? [], facilitators: facilitators.data ?? [] });
}

async function createRule(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  const invalid = validateRuleInput(b);
  if (invalid) return badRequest(invalid);
  const now = new Date().toISOString();
  // Replacing a rule voids the old one; the history of what was agreed stays.
  const { data: prior } = await supabase
    .from('revenue_split_rules')
    .select('*')
    .eq('scope', b.scope as string)
    .eq('scope_id', b.scope_id as string)
    .is('voided_at', null)
    .maybeSingle();
  if (prior) await supabase.from('revenue_split_rules').update({ voided_at: now }).eq('id', (prior as { id: string }).id);
  const { data, error } = await supabase
    .from('revenue_split_rules')
    .insert({
      scope: b.scope,
      scope_id: b.scope_id,
      kind: b.kind,
      bps: b.kind === 'percent_fee' ? Number(b.bps) : null,
      flat_facilitator_centavos: b.kind === 'flat_per_seat' ? Number(b.flat_facilitator_centavos) : null,
      fee_borne_by: b.fee_borne_by ?? 'hilom',
      note: typeof b.note === 'string' ? b.note.slice(0, 1000) : null,
      created_by: actor.label,
    })
    .select('*')
    .single<{ id: string }>();
  if (error) throw error;
  await recordAudit(actor, { action: 'finance.split_rule.create', targetTable: 'revenue_split_rules', targetId: data.id, before: prior, after: data });
  return ok({ rule: data });
}

async function voidRule(supabase: SupabaseClient, id: string, actor: AuditActor) {
  const { data, error } = await supabase
    .from('revenue_split_rules')
    .update({ voided_at: new Date().toISOString() })
    .eq('id', id)
    .is('voided_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Rule not found or already voided');
  await recordAudit(actor, { action: 'finance.split_rule.void', targetTable: 'revenue_split_rules', targetId: id, before: data });
  return ok({ ok: true });
}

/**
 * Re-split the paid event charges a rule governs that are not yet in any
 * payout batch. Charges already batched or paid keep their split — changing
 * money already promised or sent is what clawbacks and adjustments are for.
 */
async function applyRule(supabase: SupabaseClient, id: string, actor: AuditActor, dryRun: boolean) {
  const { data: rule, error } = await supabase.from('revenue_split_rules').select(SPLIT_RULE_COLUMNS).eq('id', id).is('voided_at', null).maybeSingle<SplitRule>();
  if (error) throw error;
  if (!rule) return notFound('Rule not found or voided');

  let eventIds: string[];
  if (rule.scope === 'event') eventIds = [rule.scope_id];
  else {
    const col = rule.scope === 'event_series' ? 'series_id' : 'facilitator_id';
    const { data: evs, error: evError } = await supabase.from('events').select('id').eq(col, rule.scope_id);
    if (evError) throw evError;
    eventIds = ((evs ?? []) as { id: string }[]).map((e) => e.id);
  }
  if (!eventIds.length) return ok({ changes: [], applied: 0, skipped_batched: 0 });

  const charges = await selectAll<{ id: string; event_id: string; amount_centavos: number; platform_fee_centavos: number | null; facilitator_net_centavos: number | null; payout_id: string | null; clawed_back_payout_id: string | null }>((a, b) =>
    supabase
      .from('registration_charges')
      .select('id, event_id, amount_centavos, platform_fee_centavos, facilitator_net_centavos, payout_id, clawed_back_payout_id')
      .in('event_id', eventIds)
      .eq('status', 'paid')
      .range(a, b),
  );

  const contexts = new Map<string, Awaited<ReturnType<typeof loadEventSplitContext>>>();
  const changes: { charge_id: string; from: { fee: number | null; net: number | null }; to: { fee: number | null; net: number | null } }[] = [];
  let skipped = 0;
  for (const c of charges) {
    if (c.payout_id || c.clawed_back_payout_id) {
      skipped += 1;
      continue;
    }
    if (!contexts.has(c.event_id)) contexts.set(c.event_id, await loadEventSplitContext(supabase, c.event_id));
    const ctx = contexts.get(c.event_id);
    if (!ctx) continue;
    const split = await splitForEventCharge(supabase, ctx, c.amount_centavos);
    const to = { fee: split?.platformFeeCentavos ?? null, net: split?.facilitatorNetCentavos ?? null };
    if (to.fee === c.platform_fee_centavos && to.net === c.facilitator_net_centavos) continue;
    changes.push({ charge_id: c.id, from: { fee: c.platform_fee_centavos, net: c.facilitator_net_centavos }, to });
  }

  if (!dryRun) {
    for (const ch of changes) {
      const { error: writeError } = await supabase
        .from('registration_charges')
        .update({ platform_fee_centavos: ch.to.fee, facilitator_net_centavos: ch.to.net })
        .eq('id', ch.charge_id)
        .is('payout_id', null);
      if (writeError) throw writeError;
    }
    await recordAudit(actor, {
      action: 'finance.split_rule.apply',
      targetTable: 'revenue_split_rules',
      targetId: id,
      amountCentavos: changes.reduce((s, c) => s + (c.to.net ?? 0) - (c.from.net ?? 0), 0),
      currency: 'PHP',
      after: { changed: changes.length, skipped_batched: skipped },
    });
  }
  return ok({
    changes,
    applied: dryRun ? 0 : changes.length,
    skipped_batched: skipped,
    facilitator_delta_centavos: changes.reduce((s, c) => s + (c.to.net ?? 0) - (c.from.net ?? 0), 0),
  });
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

async function listPeriods(supabase: SupabaseClient) {
  const { data, error } = await supabase.from('finance_periods').select('period, status, closed_by, closed_at, reopened_by, reopened_at').order('period', { ascending: false });
  if (error) throw error;
  return ok({ periods: data ?? [] });
}

async function closePeriod(supabase: SupabaseClient, month: string, actor: AuditActor) {
  if (!/^\d{4}-\d{2}$/.test(month)) return badRequest('month must be YYYY-MM');
  if (month >= manilaMonth(new Date())) return badRequest('Only a month that has ended can be closed');
  const d = await loadDataset(supabase);
  const snapshot = { accrual: pnlFor(d, month, 'accrual'), cash: pnlFor(d, month, 'cash') };
  const { error } = await supabase.from('finance_periods').upsert({
    period: `${month}-01`,
    status: 'closed',
    snapshot,
    closed_by: actor.label,
    closed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  await recordAudit(actor, {
    action: 'finance.period.close',
    targetTable: 'finance_periods',
    amountCentavos: snapshot.accrual.net_profit,
    currency: 'PHP',
    after: { month, net_profit: snapshot.accrual.net_profit },
    note: month,
  });
  return ok({ ok: true, snapshot });
}

async function reopenPeriod(supabase: SupabaseClient, month: string, b: Record<string, unknown>, actor: AuditActor) {
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 5) return badRequest('A reason is required to reopen a closed month');
  const { data, error } = await supabase
    .from('finance_periods')
    .update({ status: 'open', reopened_by: actor.label, reopened_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('period', `${month}-01`)
    .eq('status', 'closed')
    .select('period')
    .maybeSingle();
  if (error) throw error;
  if (!data) return notFound(`${month} is not closed`);
  await recordAudit(actor, { action: 'finance.period.reopen', targetTable: 'finance_periods', note: `${month}: ${reason}` });
  return ok({ ok: true });
}

// ---------------------------------------------------------------------------
// Offline transactions (0071)
// ---------------------------------------------------------------------------

async function listTransactions(supabase: SupabaseClient) {
  const [tx, accounts, facilitators, events] = await Promise.all([
    supabase.from('finance_transactions').select('*').order('occurred_on', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('finance_accounts').select('id, name, kind, is_active').order('created_at'),
    supabase.from('facilitators').select('id, display_name, platform_fee_bps').order('display_name'),
    supabase.from('events').select('id, title, starts_at, facilitator_id').order('starts_at', { ascending: false }).limit(300),
  ]);
  for (const r of [tx, accounts, facilitators, events]) if (r.error) throw r.error;
  return ok({ transactions: tx.data ?? [], accounts: accounts.data ?? [], facilitators: facilitators.data ?? [], events: events.data ?? [] });
}

const optionalId = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
const optionalText = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

async function createTransaction(supabase: SupabaseClient, b: Record<string, unknown>, actor: AuditActor) {
  const invalid = validateTransactionInput(b);
  if (invalid) return badRequest(invalid);
  const occurredOn = String(b.occurred_on);
  const lock = assertPeriodOpen(occurredOn.slice(0, 7), await closedSet(supabase));
  if (lock) return conflict(lock);

  const kind = String(b.kind);
  const amount = Number(b.amount_centavos);
  const facilitatorId = optionalId(b.facilitator_id);
  const eventId = optionalId(b.event_id);
  const receiptKey = b.receipt_key ?? null;
  if (receiptKey !== null && (typeof receiptKey !== 'string' || !receiptKey.startsWith(RECEIPT_PREFIX))) {
    return badRequest('receipt_key is not a finance receipt');
  }

  let hilom: number | null = null;
  let facilitatorShare: number | null = null;
  let resolvedFacilitator = facilitatorId;
  if (kind === 'offline_sale') {
    let useEventSplit = false;
    let eventSplit = null;
    if (eventId) {
      const ctx = await loadEventSplitContext(supabase, eventId);
      if (!ctx) return badRequest('That event does not exist');
      resolvedFacilitator = resolvedFacilitator ?? ctx.facilitator_id;
      // The event's own deal governs, exactly as for a PayMongo charge on it.
      useEventSplit = !!ctx.facilitator_id && ((await ruleForEvent(supabase, ctx)) !== null || ctx.platform_fee_bps !== null);
      if (useEventSplit) eventSplit = await splitForEventCharge(supabase, ctx, amount);
    }
    let facilitatorBps: number | null = null;
    if (resolvedFacilitator && !useEventSplit) {
      const { data: f, error: fError } = await supabase.from('facilitators').select('platform_fee_bps').eq('id', resolvedFacilitator).maybeSingle<{ platform_fee_bps: number }>();
      if (fError) throw fError;
      if (!f) return badRequest('That facilitator does not exist');
      facilitatorBps = f.platform_fee_bps;
    }
    const explicit = b.hilom_share_centavos === undefined || b.hilom_share_centavos === null || b.hilom_share_centavos === '' ? null : Number(b.hilom_share_centavos);
    if (explicit !== null && (!Number.isInteger(explicit) || explicit < 0 || explicit > amount)) {
      return badRequest('hilom_share_centavos must be between 0 and the amount');
    }
    const split = offlineSplit(amount, { explicitHilomCentavos: explicit, useEventSplit, eventSplit, facilitatorBps });
    hilom = split.hilom;
    facilitatorShare = split.facilitator;
    if (!resolvedFacilitator) facilitatorShare = 0;
    if (!resolvedFacilitator) hilom = amount;
  }

  const row = {
    occurred_on: occurredOn,
    kind,
    amount_centavos: amount,
    account_id: optionalId(b.account_id),
    counter_account_id: kind === 'transfer' ? optionalId(b.counter_account_id) : null,
    counterparty: optionalText(b.counterparty, 200),
    counterparty_email: optionalText(b.counterparty_email, 200)?.toLowerCase() ?? null,
    item: kind === 'offline_sale' ? optionalText(b.item, 300) : optionalText(b.item, 300),
    category: kind === 'offline_sale' ? optionalText(b.category, 100) ?? 'Other' : null,
    facilitator_id: kind === 'offline_sale' || kind === 'facilitator_payment' ? resolvedFacilitator : null,
    event_id: eventId,
    hilom_share_centavos: hilom,
    facilitator_share_centavos: facilitatorShare,
    payment_method: optionalText(b.payment_method, 100),
    reference: optionalText(b.reference, 200),
    receipt_key: receiptKey,
    receipt_name: optionalText(b.receipt_name, 200),
    notes: optionalText(b.notes, 2000),
    created_by: actor.label,
  };
  const { data, error } = await supabase.from('finance_transactions').insert(row).select('*').single<{ id: string }>();
  if (error) throw error;
  await recordAudit(actor, {
    action: `finance.transaction.${kind}`,
    targetTable: 'finance_transactions',
    targetId: data.id,
    amountCentavos: amount,
    currency: 'PHP',
    after: data,
  });
  return ok({ transaction: data });
}

/**
 * Transactions are immutable once posted — a ledger that can be edited is a
 * ledger nobody can reconcile against. Correct one by voiding it (with a
 * reason, kept) and posting the right one.
 */
async function voidTransaction(supabase: SupabaseClient, id: string, b: Record<string, unknown>, actor: AuditActor) {
  if (b.void !== true) return badRequest('Transactions are immutable; send {"void": true, "reason": "…"} to void one');
  const reason = optionalText(b.reason, 1000);
  if (!reason || reason.length < 5) return badRequest('A reason is required to void a transaction');
  const { data: before, error: readError } = await supabase.from('finance_transactions').select('*').eq('id', id).maybeSingle<{ occurred_on: string; amount_centavos: number; status: string }>();
  if (readError) throw readError;
  if (!before) return notFound('Transaction not found');
  if (before.status === 'void') return conflict('Already void');
  const lock = assertPeriodOpen(before.occurred_on.slice(0, 7), await closedSet(supabase));
  if (lock) return conflict(lock);
  const { error } = await supabase
    .from('finance_transactions')
    .update({ status: 'void', void_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'posted');
  if (error) throw error;
  await recordAudit(actor, { action: 'finance.transaction.void', targetTable: 'finance_transactions', targetId: id, amountCentavos: before.amount_centavos, currency: 'PHP', before, note: reason });
  return ok({ ok: true });
}

// ---------------------------------------------------------------------------
// Accounts (0071)
// ---------------------------------------------------------------------------

async function listAccounts(supabase: SupabaseClient, q: Record<string, string | undefined>) {
  const d = await loadDataset(supabase);
  const movements = movementsFor(d);
  const today = manilaDate(new Date());
  const months = lastMonths(6);
  const accountId = q.account ?? null;
  return ok({
    accounts: d.accounts.map((a) => ({
      ...a,
      balance_centavos: balanceAt(a, movements, today),
      months: months.map((m) => {
        const end = monthEndDay(m);
        const st = d.statements.find((s) => s.account_id === a.id && s.period.slice(0, 7) === m);
        const book = balanceAt(a, movements, end > today ? today : end);
        return { month: m, book_centavos: book, statement_centavos: st?.statement_balance_centavos ?? null, gap_centavos: st ? st.statement_balance_centavos - book : null };
      }),
    })),
    movements: accountId ? movements.filter((m) => m.account_id === accountId).reverse().slice(0, 500) : [],
    unassigned: {
      expenses: d.expenses.filter((e) => e.status === 'approved' && e.paid_by.toLowerCase() === 'company' && !(e as unknown as { account_id: string | null }).account_id).length,
      transactions: d.transactions.filter((t) => t.status === 'posted' && !t.account_id).length,
    },
  });
}

async function saveAccount(supabase: SupabaseClient, id: string | null, b: Record<string, unknown>, actor: AuditActor) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) {
    const name = optionalText(b.name, 100);
    if (!name) return badRequest('name is required');
    patch.name = name;
  }
  if (b.kind !== undefined) {
    if (!['bank', 'ewallet', 'cash', 'paymongo'].includes(String(b.kind))) return badRequest('kind must be bank, ewallet, cash or paymongo');
    patch.kind = b.kind;
  }
  if (b.opening_balance_centavos !== undefined) {
    const n = Number(b.opening_balance_centavos);
    if (!Number.isInteger(n)) return badRequest('opening_balance_centavos must be a whole number');
    patch.opening_balance_centavos = n;
  }
  if (b.opening_date !== undefined) {
    if (typeof b.opening_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.opening_date)) return badRequest('opening_date must be YYYY-MM-DD');
    patch.opening_date = b.opening_date;
  }
  if (b.notes !== undefined) patch.notes = optionalText(b.notes, 1000);
  if (b.is_active !== undefined) patch.is_active = b.is_active === true;
  if (!id && (!patch.name || !patch.kind)) return badRequest('name and kind are required');

  // One account each receives PayMongo payouts and pays facilitator batches:
  // claiming the flag moves it.
  for (const flag of ['receives_paymongo', 'default_for_payouts'] as const) {
    if (b[flag] === undefined) continue;
    if (b[flag] === true) {
      const { error } = await supabase.from('finance_accounts').update({ [flag]: false }).eq(flag, true);
      if (error) throw error;
    }
    patch[flag] = b[flag] === true;
  }

  const query = id
    ? supabase.from('finance_accounts').update(patch).eq('id', id)
    : supabase.from('finance_accounts').insert({ ...patch, created_by: actor.label });
  const { data, error } = await query.select('*').single<{ id: string }>();
  if (error) throw error;
  await recordAudit(actor, { action: id ? 'finance.account.update' : 'finance.account.create', targetTable: 'finance_accounts', targetId: data.id, after: data });
  return ok({ account: data });
}

async function saveStatement(supabase: SupabaseClient, accountId: string, b: Record<string, unknown>, actor: AuditActor) {
  const month = String(b.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) return badRequest('month must be YYYY-MM');
  const balance = Number(b.statement_balance_centavos);
  if (!Number.isInteger(balance)) return badRequest('statement_balance_centavos must be a whole number');
  const { error } = await supabase.from('finance_account_balances').upsert({
    account_id: accountId,
    period: `${month}-01`,
    statement_balance_centavos: balance,
    note: optionalText(b.note, 1000),
    entered_by: actor.label,
    entered_at: new Date().toISOString(),
  });
  if (error) throw error;
  await recordAudit(actor, { action: 'finance.account.statement', targetTable: 'finance_account_balances', targetId: accountId, amountCentavos: balance, currency: 'PHP', note: month });
  return ok({ ok: true });
}

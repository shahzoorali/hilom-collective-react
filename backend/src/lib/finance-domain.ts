/**
 * Finance arithmetic, kept pure so it can be tested without a database.
 *
 * The handler (handlers/admin-finance.ts) loads rows from v_revenue_lines,
 * v_refund_lines, payment_ledger, expenses, adjustments and payouts; everything
 * that turns those rows into a P&L, a payables figure or a list of
 * reconciliation exceptions lives here.
 *
 * Money is integer centavos throughout. Months are Asia/Manila calendar months
 * ('YYYY-MM'): Manila has no DST, so a fixed +8h offset is exact.
 */
import { splitFee } from './booking-domain.js';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 'YYYY-MM' of an instant, in Manila time. */
export function manilaMonth(iso: string | Date): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t + MANILA_OFFSET_MS).toISOString().slice(0, 7);
}

/** 'YYYY-MM-DD' of an instant, in Manila time. */
export function manilaDate(iso: string | Date): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instants bounding a Manila month: [start, end). */
export function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Bad month "${month}"`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1) - MANILA_OFFSET_MS;
  const end = Date.UTC(y, m, 1) - MANILA_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * VAT inside a PayMongo fee. PayMongo's fee is VAT-inclusive at 12%, so the
 * VAT portion is fee × 12/112 — the same split the workbook's columns made.
 */
export function feeVatCentavos(feeCentavos: number): number {
  return Math.round((feeCentavos * 12) / 112);
}

/**
 * Heuristic test-payment detector. Deliberately narrow: a real ₱1 payment by a
 * customer is still revenue, so a small amount alone is not enough — it must
 * also be ≤ ₱20 *and* either name "test" or come from a known admin email.
 * Returns the reason, or null if it looks real. Admins can override per row.
 */
export function looksLikeTestPayment(p: {
  grossCentavos: number;
  name: string | null;
  email: string | null;
  testEmails: string[];
}): string | null {
  if (p.grossCentavos > 2000) return null;
  if (p.name && /\btest(ing)?\b/i.test(p.name)) return 'auto: ≤ ₱20 and named "test"';
  if (p.email && p.testEmails.includes(p.email.trim().toLowerCase())) return 'auto: ≤ ₱20 from an admin email';
  return null;
}

// ---------------------------------------------------------------------------
// Revenue split rules
// ---------------------------------------------------------------------------

export type SplitKind = 'percent_fee' | 'flat_per_seat' | 'hilom_owned';

export interface SplitRule {
  id: string;
  scope: 'event' | 'event_series' | 'facilitator';
  scope_id: string;
  kind: SplitKind;
  bps: number | null;
  flat_facilitator_centavos: number | null;
  fee_borne_by: 'hilom' | 'facilitator';
}

export interface ResolvedSplit {
  platformFeeCentavos: number;
  facilitatorNetCentavos: number;
  ruleId: string | null;
}

/**
 * Pick the rule that governs an event: the event's own, then its series', then
 * the facilitator's. Returns null when none applies.
 */
export function pickRule(
  rules: SplitRule[],
  ctx: { eventId: string; seriesId: string | null; facilitatorId: string | null },
): SplitRule | null {
  return (
    rules.find((r) => r.scope === 'event' && r.scope_id === ctx.eventId) ??
    (ctx.seriesId ? rules.find((r) => r.scope === 'event_series' && r.scope_id === ctx.seriesId) : undefined) ??
    (ctx.facilitatorId ? rules.find((r) => r.scope === 'facilitator' && r.scope_id === ctx.facilitatorId) : undefined) ??
    null
  );
}

/**
 * The split for one paid charge. A rule wins; otherwise the event's own
 * `platform_fee_bps` (the pre-existing behaviour); otherwise null, meaning the
 * money is Hilom's alone and nothing is payable.
 *
 * `hilom_owned` returns null too — same meaning, chosen explicitly.
 */
export function resolveSplit(
  amountCentavos: number,
  rule: SplitRule | null,
  eventPlatformFeeBps: number | null,
): ResolvedSplit | null {
  if (rule) {
    if (rule.kind === 'hilom_owned') return null;
    if (rule.kind === 'flat_per_seat') {
      const net = Math.min(Math.max(0, amountCentavos), Math.max(0, rule.flat_facilitator_centavos ?? 0));
      return { platformFeeCentavos: amountCentavos - net, facilitatorNetCentavos: net, ruleId: rule.id };
    }
    const s = splitFee(amountCentavos, rule.bps ?? 0);
    return { platformFeeCentavos: s.platformFeeCentavos, facilitatorNetCentavos: s.facilitatorNetCentavos, ruleId: rule.id };
  }
  if (eventPlatformFeeBps === null) return null;
  const s = splitFee(amountCentavos, eventPlatformFeeBps);
  return { platformFeeCentavos: s.platformFeeCentavos, facilitatorNetCentavos: s.facilitatorNetCentavos, ruleId: null };
}

/** Validate a rule body from the admin form. Returns an error message or null. */
export function validateRuleInput(b: {
  scope?: unknown;
  scope_id?: unknown;
  kind?: unknown;
  bps?: unknown;
  flat_facilitator_centavos?: unknown;
  fee_borne_by?: unknown;
}): string | null {
  if (!['event', 'event_series', 'facilitator'].includes(String(b.scope))) return 'scope must be event, event_series or facilitator';
  if (typeof b.scope_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.scope_id)) return 'scope_id must be a uuid';
  if (!['percent_fee', 'flat_per_seat', 'hilom_owned'].includes(String(b.kind))) return 'kind is not recognised';
  if (b.kind === 'percent_fee') {
    const bps = Number(b.bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) return 'bps must be a whole number between 0 and 10000';
  }
  if (b.kind === 'flat_per_seat') {
    const flat = Number(b.flat_facilitator_centavos);
    if (!Number.isInteger(flat) || flat < 0) return 'flat_facilitator_centavos must be a whole number of centavos';
  }
  if (b.fee_borne_by !== undefined && !['hilom', 'facilitator'].includes(String(b.fee_borne_by))) {
    return 'fee_borne_by must be hilom or facilitator';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger rows as the handler loads them
// ---------------------------------------------------------------------------

export interface RevenueLine {
  source: string;
  source_id: string;
  parent_id: string;
  occurred_at: string;
  service_date: string;
  buyer_name: string | null;
  buyer_email: string | null;
  item: string;
  category: string;
  facilitator_id: string | null;
  event_id: string | null;
  gross_centavos: number;
  hilom_share_centavos: number;
  facilitator_share_centavos: number;
  split_missing: boolean;
  paymongo_payment_id: string | null;
  source_status: string;
  payout_id: string | null;
  clawed_back_payout_id: string | null;
  /** Joined from payment_ledger. */
  fee_centavos: number | null;
  is_test: boolean;
}

export interface RefundLine {
  source: string;
  source_id: string;
  buyer_email: string | null;
  item: string;
  facilitator_id: string | null;
  refund_centavos: number;
  refunded_at: string | null;
  decided_at: string;
  paymongo_payment_id: string | null;
}

export interface ExpenseRow {
  id: string;
  incurred_on: string; // YYYY-MM-DD
  vendor: string;
  description: string;
  category: string;
  amount_centavos: number;
  paid_by: string;
  receipt_key: string | null;
  reimbursement_id: string | null;
  status: 'draft' | 'approved' | 'void';
}

export interface AdjustmentRow {
  id: string;
  period: string; // YYYY-MM-01
  line: 'revenue' | 'payment_costs' | 'opex' | 'other';
  amount_centavos: number;
  reason: string;
  voided_at: string | null;
}

export interface PaidPayoutRow {
  id: string;
  facilitator_id: string;
  paid_at: string | null;
  status: string;
  processing_fee_centavos: number;
  net_centavos: number;
}

export type Basis = 'accrual' | 'cash';

/** The refund source that owns a revenue line's refunds. */
const REFUND_SOURCE_FOR: Record<string, string> = {
  orders: 'orders',
  registration_charges: 'event_registrations',
  class_registrations: 'class_registrations',
  bookings: 'bookings',
  booking_packages: 'booking_packages',
};

function refundKey(source: string, id: string): string {
  return `${source}:${id}`;
}

/**
 * Hilom's part of each refund, by refund key. A refund reverses the sale's
 * split in proportion: refunding a ₱2,500 seat where Hilom kept ₱1,000 takes
 * ₱1,000 off Hilom revenue and ₱1,500 off what the facilitator is owed.
 */
export function refundShares(
  lines: RevenueLine[],
  refunds: RefundLine[],
): Map<string, { hilom: number; facilitator: number; gross: number; serviceDate: string | null }> {
  const byParent = new Map<string, RevenueLine[]>();
  for (const l of lines) {
    const k = refundKey(REFUND_SOURCE_FOR[l.source] ?? l.source, l.parent_id);
    const list = byParent.get(k);
    if (list) list.push(l);
    else byParent.set(k, [l]);
  }
  const out = new Map<string, { hilom: number; facilitator: number; gross: number; serviceDate: string | null }>();
  for (const r of refunds) {
    const k = refundKey(r.source, r.source_id);
    const owning = byParent.get(k) ?? [];
    const gross = owning.reduce((s, l) => s + l.gross_centavos, 0);
    const hilomBase = owning.reduce((s, l) => s + l.hilom_share_centavos, 0);
    const amount = Math.min(r.refund_centavos, gross || r.refund_centavos);
    const hilom = gross > 0 ? Math.round((amount * hilomBase) / gross) : amount;
    out.set(k, { hilom, facilitator: amount - hilom, gross: amount, serviceDate: owning[0]?.service_date ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// P&L
// ---------------------------------------------------------------------------

export interface PnlLine {
  key: string;
  label: string;
  centavos: number;
  /** For drill-down: which rows built this line. */
  count?: number;
}

export interface Pnl {
  month: string;
  basis: Basis;
  gross_sales: number;
  facilitator_share: number;
  hilom_share: number;
  refunds_hilom: number;
  revenue_adjustments: number;
  net_revenue: number;
  paymongo_fees: number;
  fees_recovered: number;
  fees_unknown_count: number;
  payment_cost_adjustments: number;
  gross_profit: number;
  opex: PnlLine[];
  opex_total: number;
  other_adjustments: number;
  net_profit: number;
  by_category: { category: string; gross: number; hilom: number; count: number }[];
  sales_count: number;
}

export interface PnlInput {
  month: string;
  basis: Basis;
  lines: RevenueLine[];
  refunds: RefundLine[];
  expenses: ExpenseRow[];
  adjustments: AdjustmentRow[];
  payouts: PaidPayoutRow[];
  includeTests?: boolean;
}

export const EXPENSE_CATEGORIES = [
  'Marketing / Advertising',
  'Website / Hosting / Software',
  'Professional Fees',
  'Admin / Operations',
  'Venue / Event Cost',
  'Taxes / Licenses',
  'Other',
] as const;

/** Which month a revenue line belongs to under a basis. */
export function lineMonth(l: RevenueLine, basis: Basis): string {
  return manilaMonth(basis === 'accrual' ? l.service_date : l.occurred_at);
}

/** Which month a refund belongs to under a basis, or null if not yet sent (cash). */
export function refundMonth(r: RefundLine, basis: Basis): string | null {
  if (basis === 'cash') return r.refunded_at ? manilaMonth(r.refunded_at) : null;
  return manilaMonth(r.decided_at);
}

export function buildPnl(input: PnlInput): Pnl {
  const { month, basis } = input;
  const lines = input.lines.filter((l) => (input.includeTests || !l.is_test) && lineMonth(l, basis) === month);

  let gross = 0;
  let facilitator = 0;
  let hilom = 0;
  let fees = 0;
  let feesUnknown = 0;
  const cats = new Map<string, { category: string; gross: number; hilom: number; count: number }>();
  for (const l of lines) {
    gross += l.gross_centavos;
    facilitator += l.facilitator_share_centavos;
    hilom += l.hilom_share_centavos;
    if (l.fee_centavos === null) {
      if (l.paymongo_payment_id) feesUnknown += 1;
    } else fees += l.fee_centavos;
    const c = cats.get(l.category) ?? { category: l.category, gross: 0, hilom: 0, count: 0 };
    c.gross += l.gross_centavos;
    c.hilom += l.hilom_share_centavos;
    c.count += 1;
    cats.set(l.category, c);
  }

  const shares = refundShares(input.lines, input.refunds);
  let refundsHilom = 0;
  for (const r of input.refunds) {
    if (refundMonth(r, basis) !== month) continue;
    refundsHilom += shares.get(refundKey(r.source, r.source_id))?.hilom ?? r.refund_centavos;
  }

  // Fees recovered from facilitators: the processing fee an admin deducted on
  // a payout batch, counted when the batch was paid.
  const recovered = input.payouts
    .filter((p) => p.status === 'paid' && p.paid_at && manilaMonth(p.paid_at) === month)
    .reduce((s, p) => s + (p.processing_fee_centavos ?? 0), 0);

  const periodKey = `${month}-01`;
  const adj = input.adjustments.filter((a) => !a.voided_at && a.period.slice(0, 10) === periodKey);
  const sumAdj = (line: AdjustmentRow['line']) => adj.filter((a) => a.line === line).reduce((s, a) => s + a.amount_centavos, 0);
  const revenueAdj = sumAdj('revenue');
  const paymentAdj = sumAdj('payment_costs');
  const opexAdj = sumAdj('opex');
  const otherAdj = sumAdj('other');

  const netRevenue = hilom - refundsHilom + revenueAdj;
  // Payment adjustments are signed like every adjustment: negative is a cost.
  const grossProfit = netRevenue - fees + recovered + paymentAdj;

  const expenses = input.expenses.filter((e) => e.status === 'approved' && e.incurred_on.slice(0, 7) === month);
  const opex: PnlLine[] = EXPENSE_CATEGORIES.map((category) => {
    const rows = expenses.filter((e) => e.category === category);
    return { key: category, label: category, centavos: rows.reduce((s, e) => s + e.amount_centavos, 0), count: rows.length };
  });
  if (opexAdj !== 0) opex.push({ key: 'adjustments', label: 'Opex adjustments', centavos: -opexAdj });
  const opexTotal = opex.reduce((s, l) => s + l.centavos, 0);

  return {
    month,
    basis,
    gross_sales: gross,
    facilitator_share: facilitator,
    hilom_share: hilom,
    refunds_hilom: refundsHilom,
    revenue_adjustments: revenueAdj,
    net_revenue: netRevenue,
    paymongo_fees: fees,
    fees_recovered: recovered,
    fees_unknown_count: feesUnknown,
    payment_cost_adjustments: paymentAdj,
    gross_profit: grossProfit,
    opex,
    opex_total: opexTotal,
    other_adjustments: otherAdj,
    net_profit: grossProfit - opexTotal + otherAdj,
    by_category: [...cats.values()].sort((a, b) => b.gross - a.gross),
    sales_count: lines.length,
  };
}

// ---------------------------------------------------------------------------
// Payables
// ---------------------------------------------------------------------------

export interface FacilitatorPayable {
  facilitator_id: string;
  /** Delivered-or-not, every facilitator share not yet in a payout batch. */
  unbatched_centavos: number;
  unbatched_count: number;
  /** In a draft/approved batch, not yet paid. */
  batched_unpaid_centavos: number;
  /** Refunds on sales already paid out, not yet clawed back. */
  clawback_due_centavos: number;
}

export function facilitatorPayables(
  lines: RevenueLine[],
  refunds: RefundLine[],
  payoutStatus: Map<string, string>,
): FacilitatorPayable[] {
  const shares = refundShares(lines, refunds);
  const refundedParents = new Set(refunds.map((r) => refundKey(r.source, r.source_id)));
  const out = new Map<string, FacilitatorPayable>();
  const get = (id: string) => {
    let p = out.get(id);
    if (!p) {
      p = { facilitator_id: id, unbatched_centavos: 0, unbatched_count: 0, batched_unpaid_centavos: 0, clawback_due_centavos: 0 };
      out.set(id, p);
    }
    return p;
  };
  const clawCounted = new Set<string>();
  for (const l of lines) {
    if (!l.facilitator_id || l.facilitator_share_centavos <= 0 || l.is_test) continue;
    const rk = refundKey(REFUND_SOURCE_FOR[l.source] ?? l.source, l.parent_id);
    const refunded = refundedParents.has(rk);
    const status = l.payout_id ? payoutStatus.get(l.payout_id) : undefined;
    const p = get(l.facilitator_id);
    if (!l.payout_id || status === 'void') {
      if (!refunded) {
        p.unbatched_centavos += l.facilitator_share_centavos;
        p.unbatched_count += 1;
      }
    } else if (status === 'paid') {
      if (refunded && !l.clawed_back_payout_id && !clawCounted.has(rk)) {
        clawCounted.add(rk);
        p.clawback_due_centavos += shares.get(rk)?.facilitator ?? 0;
      }
    } else {
      p.batched_unpaid_centavos += l.facilitator_share_centavos;
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Reconciliation exceptions
// ---------------------------------------------------------------------------

export type ExceptionSeverity = 'high' | 'medium' | 'low';

export interface FinanceException {
  /** Stable while the underlying numbers are unchanged — acks key on it. */
  key: string;
  kind:
    | 'refund_owed'
    | 'refund_after_payout'
    | 'duplicate_charge'
    | 'fee_missing'
    | 'ledger_orphan'
    | 'amount_mismatch'
    | 'split_missing'
    | 'expense_future'
    | 'expense_no_receipt'
    | 'closed_period_changed'
    | 'reimbursement_owed'
    | 'account_gap'
    | 'facilitator_credit';
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  amount_centavos?: number;
  link?: { source: string; id: string };
}

export interface LedgerRow {
  paymongo_payment_id: string;
  source_table: string;
  gross_centavos: number;
  fee_centavos: number | null;
  fetch_error: string | null;
  is_test: boolean;
}

export interface ExceptionInput {
  lines: RevenueLine[];
  refunds: RefundLine[];
  ledger: LedgerRow[];
  expenses: ExpenseRow[];
  payoutStatus: Map<string, string>;
  closedPeriods: { month: string; snapshotNet: number; currentNet: number }[];
  reimbursementsOwed: { id: string; payee: string; total_centavos: number }[];
  today: string; // YYYY-MM-DD, Manila
  /** Duplicate window. */
  duplicateWindowMinutes?: number;
}

export const peso = (c: number) => `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function detectExceptions(input: ExceptionInput): FinanceException[] {
  const out: FinanceException[] = [];
  const window = (input.duplicateWindowMinutes ?? 30) * 60_000;

  // Refunds decided but not sent.
  for (const r of input.refunds) {
    if (r.refunded_at) continue;
    out.push({
      key: `refund_owed:${r.source}:${r.source_id}:${r.refund_centavos}`,
      kind: 'refund_owed',
      severity: 'high',
      title: `Refund owed, not sent — ${r.item}`,
      detail: `${peso(r.refund_centavos)} to ${r.buyer_email ?? 'buyer'}, decided ${manilaDate(r.decided_at)}. Nothing records it as sent.`,
      amount_centavos: r.refund_centavos,
      link: { source: r.source, id: r.source_id },
    });
  }

  // Refunded sales already paid out to the facilitator with no clawback.
  const payables = facilitatorPayables(input.lines, input.refunds, input.payoutStatus);
  for (const p of payables) {
    if (p.clawback_due_centavos <= 0) continue;
    out.push({
      key: `refund_after_payout:${p.facilitator_id}:${p.clawback_due_centavos}`,
      kind: 'refund_after_payout',
      severity: 'high',
      title: 'Refunded sale already paid to facilitator',
      detail: `${peso(p.clawback_due_centavos)} of facilitator share was paid out on sales since refunded, and no later batch claws it back.`,
      amount_centavos: p.clawback_due_centavos,
      link: { source: 'facilitators', id: p.facilitator_id },
    });
  }

  // Duplicate charges: same buyer, same item, close together, neither refunded.
  const refunded = new Set(input.refunds.map((r) => refundKey(r.source, r.source_id)));
  const groups = new Map<string, RevenueLine[]>();
  for (const l of input.lines) {
    if (l.is_test || !l.buyer_email) continue;
    const g = `${l.buyer_email.toLowerCase()}|${l.event_id ?? l.item}`;
    const list = groups.get(g);
    if (list) list.push(l);
    else groups.set(g, [l]);
  }
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (a.parent_id === b.parent_id) continue; // instalments of one registration
      if (Date.parse(b.occurred_at) - Date.parse(a.occurred_at) > window) continue;
      if (refunded.has(refundKey(REFUND_SOURCE_FOR[b.source] ?? b.source, b.parent_id))) continue;
      out.push({
        key: `duplicate_charge:${a.source_id}:${b.source_id}`,
        kind: 'duplicate_charge',
        severity: 'high',
        title: `Possible duplicate charge — ${b.item}`,
        detail: `${b.buyer_email} paid ${peso(a.gross_centavos)} and ${peso(b.gross_centavos)} ${Math.round((Date.parse(b.occurred_at) - Date.parse(a.occurred_at)) / 60000)} min apart. Confirm both are real seats or refund one.`,
        amount_centavos: b.gross_centavos,
        link: { source: b.source, id: b.source_id },
      });
    }
  }

  // PayMongo ledger completeness.
  const ledgerById = new Map(input.ledger.map((r) => [r.paymongo_payment_id, r]));
  for (const l of input.lines) {
    // A test payment (including a test-mode one live PayMongo has never heard
    // of) is not owed a fee.
    if (l.is_test || !l.paymongo_payment_id?.startsWith('pay_')) continue;
    const led = ledgerById.get(l.paymongo_payment_id);
    if (!led || led.fee_centavos === null) {
      out.push({
        key: `fee_missing:${l.paymongo_payment_id}`,
        kind: 'fee_missing',
        severity: 'low',
        title: `PayMongo fee not captured — ${l.item}`,
        detail: led?.fetch_error
          ? `Fetching ${l.paymongo_payment_id} failed: ${led.fetch_error}`
          : `${l.paymongo_payment_id} has no ledger row yet; the nightly job or "Refresh from PayMongo" will fill it.`,
        link: { source: l.source, id: l.source_id },
      });
    } else if (led.gross_centavos !== l.gross_centavos && l.source !== 'registration_charges') {
      out.push({
        key: `amount_mismatch:${l.paymongo_payment_id}:${led.gross_centavos}:${l.gross_centavos}`,
        kind: 'amount_mismatch',
        severity: 'medium',
        title: `Amount differs from PayMongo — ${l.item}`,
        detail: `Our record says ${peso(l.gross_centavos)}, PayMongo charged ${peso(led.gross_centavos)}.`,
        link: { source: l.source, id: l.source_id },
      });
    }
  }
  for (const r of input.ledger) {
    if (r.source_table !== 'unknown' || r.is_test) continue;
    out.push({
      key: `ledger_orphan:${r.paymongo_payment_id}`,
      kind: 'ledger_orphan',
      severity: 'medium',
      title: 'PayMongo payment with no sale',
      detail: `${r.paymongo_payment_id} (${peso(r.gross_centavos)}) is in PayMongo but matches no order, registration, class seat or booking.`,
      amount_centavos: r.gross_centavos,
    });
  }

  // Facilitator events with no revenue split — grouped per event.
  const missing = new Map<string, { item: string; count: number; gross: number }>();
  for (const l of input.lines) {
    if (!l.split_missing || l.is_test) continue;
    const k = l.event_id ?? l.item;
    const m = missing.get(k) ?? { item: l.item.split(' — ')[0]!, count: 0, gross: 0 };
    m.count += 1;
    m.gross += l.gross_centavos;
    missing.set(k, m);
  }
  for (const [eventId, m] of missing) {
    out.push({
      key: `split_missing:${eventId}:${m.count}`,
      kind: 'split_missing',
      severity: 'medium',
      title: `No revenue split — ${m.item}`,
      detail: `${m.count} paid charge(s), ${peso(m.gross)}, on a facilitator's event with no split set. They are counted as 100% Hilom and nothing is payable until a split rule is applied.`,
      amount_centavos: m.gross,
      link: { source: 'events', id: eventId },
    });
  }

  // Expenses.
  for (const e of input.expenses) {
    if (e.status !== 'approved') continue;
    if (e.incurred_on > input.today) {
      out.push({
        key: `expense_future:${e.id}:${e.incurred_on}`,
        kind: 'expense_future',
        severity: 'medium',
        title: `Expense dated in the future — ${e.vendor}`,
        detail: `${peso(e.amount_centavos)} dated ${e.incurred_on}. If it is a commitment rather than a payment, keep it as a draft until paid.`,
        amount_centavos: e.amount_centavos,
        link: { source: 'expenses', id: e.id },
      });
    }
    if (!e.receipt_key) {
      out.push({
        key: `expense_no_receipt:${e.id}`,
        kind: 'expense_no_receipt',
        severity: 'low',
        title: `No receipt — ${e.vendor}`,
        detail: `${peso(e.amount_centavos)} on ${e.incurred_on} (${e.category}) has no receipt attached.`,
        amount_centavos: e.amount_centavos,
        link: { source: 'expenses', id: e.id },
      });
    }
  }

  for (const p of input.closedPeriods) {
    if (p.snapshotNet === p.currentNet) continue;
    out.push({
      key: `closed_period_changed:${p.month}:${p.currentNet}`,
      kind: 'closed_period_changed',
      severity: 'high',
      title: `Closed month ${p.month} no longer matches its close`,
      detail: `Net profit was ${peso(p.snapshotNet)} at close and recomputes to ${peso(p.currentNet)}. Something under it changed (a late refund or a split applied); post an adjustment in the open month or reopen ${p.month}.`,
      amount_centavos: p.currentNet - p.snapshotNet,
    });
  }

  for (const r of input.reimbursementsOwed) {
    if (r.total_centavos <= 0) continue;
    out.push({
      key: `reimbursement_owed:${r.id}:${r.total_centavos}`,
      kind: 'reimbursement_owed',
      severity: 'low',
      title: `Reimbursement owed to ${r.payee}`,
      detail: `${peso(r.total_centavos)} of company expenses were paid personally and are not yet paid back.`,
      amount_centavos: r.total_centavos,
      link: { source: 'reimbursements', id: r.id },
    });
  }

  const rank: Record<ExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The month an expense or adjustment would land in, and whether it is closed. */
export function assertPeriodOpen(month: string, closed: Set<string>): string | null {
  return closed.has(month)
    ? `${month} is closed. Reopen it, or record this as an adjustment in an open month.`
    : null;
}

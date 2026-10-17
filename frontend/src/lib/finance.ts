/**
 * Admin → Finance API client. Every call goes to /admin/finance/* on the
 * backend (handlers/admin-finance.ts); the numbers are derived server-side
 * from the platform's own transactions plus PayMongo's recorded fees.
 */
import { apiFetch } from './api';
import { adminActor } from './cms';
import { API_BASE } from '../config';

const init = (adminKey: string, method?: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    'x-admin-key': adminKey,
    ...(adminActor() ? { 'x-admin-actor': adminActor() } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

const qs = (params: Record<string, string | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export type Basis = 'accrual' | 'cash';

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
  opex: { key: string; label: string; centavos: number; count?: number }[];
  opex_total: number;
  other_adjustments: number;
  net_profit: number;
  by_category: { category: string; gross: number; hilom: number; count: number }[];
  sales_count: number;
}

export interface FinanceException {
  key: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  amount_centavos?: number;
  link?: { source: string; id: string };
  ack: { note: string | null; acked_by: string | null; acked_at: string } | null;
}

export interface FinanceOverview {
  month: string;
  current: Pnl;
  previous: Pnl;
  trend: { month: string; gross_sales: number; net_revenue: number; net_profit: number; opex: number }[];
  kpis: {
    facilitator_owed_centavos: number;
    clawback_due_centavos: number;
    refunds_owed_centavos: number;
    refunds_owed_count: number;
    paymongo_pending_payout_centavos: number;
    ledger_coverage: { payments: number; with_fee: number };
  };
  exceptions: { total: number; high: number; top: FinanceException[] };
}

export interface RevenueRow {
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
  facilitator_name: string | null;
  event_id: string | null;
  gross_centavos: number;
  hilom_share_centavos: number;
  facilitator_share_centavos: number;
  split_missing: boolean;
  paymongo_payment_id: string | null;
  source_status: string;
  payout_id: string | null;
  payout_status: string | null;
  fee_centavos: number | null;
  net_centavos: number | null;
  method: string | null;
  paymongo_payout_id: string | null;
  is_test: boolean;
  test_reason: string | null;
  refund: { centavos: number; sent_at: string | null } | null;
}

export interface RevenueResponse {
  rows: RevenueRow[];
  truncated: boolean;
  totals: { count: number; gross_centavos: number; fee_centavos: number; hilom_share_centavos: number; facilitator_share_centavos: number };
  categories: string[];
  facilitators: { id: string; name: string }[];
}

export interface RevenueFilters {
  from?: string;
  to?: string;
  basis?: Basis;
  category?: string;
  facilitator?: string;
  status?: string;
  tests?: string;
  search?: string;
}

export interface Payables {
  facilitators: {
    facilitator_id: string;
    name: string;
    platform_fee_bps: number | null;
    unbatched_centavos: number;
    unbatched_count: number;
    batched_unpaid_centavos: number;
    clawback_due_centavos: number;
    paid_total_centavos: number;
    last_paid_at: string | null;
  }[];
  refunds: {
    source: string;
    source_id: string;
    buyer_email: string | null;
    item: string;
    facilitator_name: string | null;
    refund_centavos: number;
    refunded_at: string | null;
    decided_at: string;
  }[];
  payouts: {
    id: string;
    facilitator_name: string | null;
    status: string;
    period_start: string;
    period_end: string;
    gross_centavos: number;
    platform_fee_centavos: number;
    processing_fee_centavos: number;
    clawback_centavos: number;
    net_centavos: number;
    paid_at: string | null;
    reference: string | null;
  }[];
}

export interface Reconciliation {
  exceptions: FinanceException[];
  payout_groups: { payout_id: string | null; count: number; gross: number; fees: number; net: number; first: string | null; last: string | null }[];
  ledger: { rows: number; missing_fee: number; errors: number; tests: number };
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

export interface Expense {
  id: string;
  incurred_on: string;
  vendor: string;
  description: string;
  category: string;
  amount_centavos: number;
  vat_centavos: number;
  paid_by: string;
  payment_method: string | null;
  event_id: string | null;
  receipt_key: string | null;
  receipt_name: string | null;
  reimbursement_id: string | null;
  status: 'draft' | 'approved' | 'void';
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Reimbursement {
  id: string;
  payee: string;
  status: 'owed' | 'paid' | 'void';
  paid_at: string | null;
  reference: string | null;
  note: string | null;
  total_centavos: number;
  expenses: { id: string; amount_centavos: number; vendor: string; incurred_on: string; status: string }[];
}

export interface Adjustment {
  id: string;
  period: string;
  line: 'revenue' | 'payment_costs' | 'opex' | 'other';
  amount_centavos: number;
  reason: string;
  link: string | null;
  voided_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SplitRule {
  id: string;
  scope: 'event' | 'event_series' | 'facilitator';
  scope_id: string;
  kind: 'percent_fee' | 'flat_per_seat' | 'hilom_owned';
  bps: number | null;
  flat_facilitator_centavos: number | null;
  fee_borne_by: 'hilom' | 'facilitator';
  note: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
}

export interface SplitRulesResponse {
  rules: SplitRule[];
  events: { id: string; title: string; starts_at: string | null; facilitator_id: string; series_id: string | null; platform_fee_bps: number | null }[];
  series: { id: string; title: string }[];
  facilitators: { id: string; display_name: string; platform_fee_bps: number; default_event_platform_fee_bps: number | null }[];
}

export interface ApplyResult {
  changes: { charge_id: string; from: { fee: number | null; net: number | null }; to: { fee: number | null; net: number | null } }[];
  applied: number;
  skipped_batched: number;
  facilitator_delta_centavos: number;
}

const base = '/admin/finance';

export const finance = {
  overview: (k: string) => apiFetch<FinanceOverview>(`${base}/overview`, init(k)),
  revenue: (k: string, f: RevenueFilters) => apiFetch<RevenueResponse>(`${base}/revenue${qs({ ...f })}`, init(k)),
  async revenueCsv(k: string, f: RevenueFilters) {
    const res = await fetch(`${API_BASE}${base}/revenue.csv${qs({ ...f })}`, init(k));
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hilom-sales-${f.from ?? 'all'}-${f.to ?? 'now'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
  pnl: (k: string, month: string, basis: Basis) =>
    apiFetch<{ pnl: Pnl; previous: Pnl; period: { status: string; closed_by?: string | null; closed_at?: string | null; snapshot?: Pnl | null }; adjustments: Adjustment[] }>(
      `${base}/pnl${qs({ month, basis })}`,
      init(k),
    ),
  payables: (k: string) => apiFetch<Payables>(`${base}/payables`, init(k)),
  reconciliation: (k: string, all = false) => apiFetch<Reconciliation>(`${base}/reconciliation${all ? '?all=1' : ''}`, init(k)),
  ack: (k: string, key: string, note: string, undo = false) => apiFetch<{ ok: true }>(`${base}/reconciliation/ack`, init(k, 'POST', { key, note, undo })),
  refreshLedger: (k: string, body: { paymentIds?: string[]; missing?: boolean } = {}) =>
    apiFetch<{ refreshed: number; failed: { id: string; error?: string }[]; remaining: number }>(`${base}/ledger/refresh`, init(k, 'POST', body)),
  setTest: (k: string, paymentId: string, isTest: boolean) =>
    apiFetch<{ ok: true }>(`${base}/ledger/${encodeURIComponent(paymentId)}/test`, init(k, 'PUT', { is_test: isTest })),

  expenses: (k: string) =>
    apiFetch<{ expenses: Expense[]; categories: string[]; events: { id: string; title: string; starts_at: string | null }[] }>(`${base}/expenses`, init(k)),
  saveExpense: (k: string, id: string | null, body: Partial<Expense>) =>
    apiFetch<{ expense: Expense }>(id ? `${base}/expenses/${id}` : `${base}/expenses`, init(k, id ? 'PUT' : 'POST', body)),
  async uploadReceipt(k: string, file: File): Promise<{ key: string; name: string }> {
    const { uploadUrl, key, name } = await apiFetch<{ uploadUrl: string; key: string; name: string }>(
      `${base}/expenses/receipt-url`,
      init(k, 'POST', { filename: file.name, contentType: file.type }),
    );
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error(`Receipt upload failed (${put.status})`);
    return { key, name };
  },
  receiptUrl: (k: string, id: string) => apiFetch<{ url: string }>(`${base}/expenses/${id}/receipt`, init(k)),

  reimbursements: (k: string) => apiFetch<{ reimbursements: Reimbursement[] }>(`${base}/reimbursements`, init(k)),
  updateReimbursement: (k: string, id: string, body: { status: string; reference?: string; note?: string }) =>
    apiFetch<{ reimbursement: Reimbursement }>(`${base}/reimbursements/${id}`, init(k, 'PUT', body)),

  createAdjustment: (k: string, body: { month: string; line: string; amount_centavos: number; reason: string; link?: string }) =>
    apiFetch<{ adjustment: Adjustment }>(`${base}/adjustments`, init(k, 'POST', body)),
  voidAdjustment: (k: string, id: string) => apiFetch<{ ok: true }>(`${base}/adjustments/${id}`, init(k, 'PUT', { void: true })),

  splitRules: (k: string) => apiFetch<SplitRulesResponse>(`${base}/split-rules`, init(k)),
  createSplitRule: (k: string, body: Partial<SplitRule>) => apiFetch<{ rule: SplitRule }>(`${base}/split-rules`, init(k, 'POST', body)),
  voidSplitRule: (k: string, id: string) => apiFetch<{ ok: true }>(`${base}/split-rules/${id}`, init(k, 'DELETE')),
  previewSplitRule: (k: string, id: string) => apiFetch<ApplyResult>(`${base}/split-rules/${id}/preview`, init(k)),
  applySplitRule: (k: string, id: string) => apiFetch<ApplyResult>(`${base}/split-rules/${id}/apply`, init(k, 'POST', {})),

  periods: (k: string) => apiFetch<{ periods: { period: string; status: string; closed_by: string | null; closed_at: string | null }[] }>(`${base}/periods`, init(k)),
  closePeriod: (k: string, month: string) => apiFetch<{ ok: true }>(`${base}/periods/${month}/close`, init(k, 'POST', {})),
  reopenPeriod: (k: string, month: string, reason: string) => apiFetch<{ ok: true }>(`${base}/periods/${month}/reopen`, init(k, 'POST', { reason })),
};

/** 'YYYY-MM' → "October 2026". */
export const monthLabel = (m: string) =>
  new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

/** Current Manila month. */
export const thisMonth = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);

export const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
};

export const manilaDay = (iso: string) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10);

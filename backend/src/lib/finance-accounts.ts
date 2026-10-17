/**
 * Offline transactions and money accounts (0071), kept pure like
 * finance-domain.ts, which it builds on.
 *
 *   offline sales      → sales-register lines (P&L, categories, duplicates)
 *   facilitator money  → balances: platform payables + offline shares − offline payments
 *   every movement     → per-account book balances, reconciled to statements
 */
import { splitFee } from './booking-domain.js';
import {
  facilitatorPayables,
  manilaDate,
  peso,
  type ExpenseRow,
  type FacilitatorPayable,
  type FinanceException,
  type PaidPayoutRow,
  type RefundLine,
  type ResolvedSplit,
  type RevenueLine,
} from './finance-domain.js';

export type TransactionKind =
  | 'offline_sale'
  | 'facilitator_payment'
  | 'owner_contribution'
  | 'owner_withdrawal'
  | 'loan_in'
  | 'loan_repayment'
  | 'transfer'
  | 'other_in'
  | 'other_out';

/** Money in (+1) or out (−1) of `account_id`. A transfer also credits `counter_account_id`. */
export const TRANSACTION_DIRECTION: Record<TransactionKind, 1 | -1> = {
  offline_sale: 1,
  facilitator_payment: -1,
  owner_contribution: 1,
  owner_withdrawal: -1,
  loan_in: 1,
  loan_repayment: -1,
  transfer: -1,
  other_in: 1,
  other_out: -1,
};

export const TRANSACTION_KINDS = Object.keys(TRANSACTION_DIRECTION) as TransactionKind[];

export interface FinanceTransaction {
  id: string;
  occurred_on: string; // YYYY-MM-DD
  kind: TransactionKind;
  amount_centavos: number;
  account_id: string | null;
  counter_account_id: string | null;
  counterparty: string | null;
  counterparty_email: string | null;
  item: string | null;
  category: string | null;
  facilitator_id: string | null;
  event_id: string | null;
  hilom_share_centavos: number | null;
  facilitator_share_centavos: number | null;
  reference: string | null;
  status: 'posted' | 'void';
  created_at: string;
}

/** Manila noon on a date, so month bucketing never slips across midnight. */
const noonManila = (day: string) => `${day}T04:00:00.000Z`;

/** An offline sale as a sales-register line — the P&L treats it like any sale, with no PayMongo fee. */
export function offlineSaleLine(t: FinanceTransaction): RevenueLine {
  return {
    source: 'finance_transactions',
    source_id: t.id,
    parent_id: t.id,
    occurred_at: noonManila(t.occurred_on),
    service_date: noonManila(t.occurred_on),
    buyer_name: t.counterparty,
    buyer_email: t.counterparty_email,
    item: t.item ?? 'Offline sale',
    category: t.category ?? 'Other',
    facilitator_id: t.facilitator_id,
    event_id: t.event_id,
    gross_centavos: t.amount_centavos,
    hilom_share_centavos: t.hilom_share_centavos ?? t.amount_centavos,
    facilitator_share_centavos: t.facilitator_share_centavos ?? 0,
    split_missing: false,
    paymongo_payment_id: null,
    source_status: 'paid',
    payout_id: null,
    clawed_back_payout_id: null,
    fee_centavos: 0,
    is_test: false,
  };
}

/**
 * Split for an offline sale. Precedence: an explicit Hilom share typed on the
 * form → the event's split (rule or rate; null there means Hilom-owned) →
 * the facilitator's standard rate → all Hilom when there is no facilitator.
 */
export function offlineSplit(
  amountCentavos: number,
  opts: { explicitHilomCentavos?: number | null; eventSplit?: ResolvedSplit | null; useEventSplit?: boolean; facilitatorBps?: number | null },
): { hilom: number; facilitator: number } {
  if (opts.explicitHilomCentavos !== undefined && opts.explicitHilomCentavos !== null) {
    const hilom = Math.min(amountCentavos, Math.max(0, Math.round(opts.explicitHilomCentavos)));
    return { hilom, facilitator: amountCentavos - hilom };
  }
  if (opts.useEventSplit) {
    return opts.eventSplit
      ? { hilom: opts.eventSplit.platformFeeCentavos, facilitator: opts.eventSplit.facilitatorNetCentavos }
      : { hilom: amountCentavos, facilitator: 0 };
  }
  if (opts.facilitatorBps === null || opts.facilitatorBps === undefined) return { hilom: amountCentavos, facilitator: 0 };
  const s = splitFee(amountCentavos, opts.facilitatorBps);
  return { hilom: s.platformFeeCentavos, facilitator: s.facilitatorNetCentavos };
}

/** Validate a transaction body. Returns an error message or null. */
export function validateTransactionInput(b: Record<string, unknown>): string | null {
  if (!TRANSACTION_KINDS.includes(b.kind as TransactionKind)) return 'kind is not recognised';
  if (typeof b.occurred_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.occurred_on)) return 'occurred_on must be YYYY-MM-DD';
  const amount = Number(b.amount_centavos);
  if (!Number.isInteger(amount) || amount <= 0) return 'amount_centavos must be a whole, positive number of centavos';
  if (b.kind === 'facilitator_payment' && !b.facilitator_id) return 'Choose the facilitator who was paid';
  if (b.kind === 'transfer') {
    if (!b.account_id || !b.counter_account_id) return 'A transfer needs a from and a to account';
    if (b.account_id === b.counter_account_id) return 'A transfer must be between two different accounts';
  }
  if (b.kind === 'offline_sale' && (typeof b.item !== 'string' || !b.item.trim())) return 'Say what was sold';
  return null;
}

export interface FacilitatorBalance extends FacilitatorPayable {
  /** Facilitator shares on offline sales — never batched, settled by offline payments. */
  offline_owed_centavos: number;
  /** Money sent outside a payout batch. */
  paid_offline_centavos: number;
  /** All owed less clawbacks and offline payments. Negative = paid ahead (credit). */
  net_owed_centavos: number;
}

export function facilitatorBalances(
  lines: RevenueLine[],
  refunds: RefundLine[],
  payoutStatus: Map<string, string>,
  transactions: FinanceTransaction[],
): FacilitatorBalance[] {
  const platform = facilitatorPayables(lines.filter((l) => l.source !== 'finance_transactions'), refunds, payoutStatus);
  const out = new Map<string, FacilitatorBalance>(
    platform.map((p) => [p.facilitator_id, { ...p, offline_owed_centavos: 0, paid_offline_centavos: 0, net_owed_centavos: 0 }]),
  );
  const get = (id: string) => {
    let b = out.get(id);
    if (!b) {
      b = {
        facilitator_id: id,
        unbatched_centavos: 0,
        unbatched_count: 0,
        batched_unpaid_centavos: 0,
        clawback_due_centavos: 0,
        offline_owed_centavos: 0,
        paid_offline_centavos: 0,
        net_owed_centavos: 0,
      };
      out.set(id, b);
    }
    return b;
  };
  for (const t of transactions) {
    if (t.status !== 'posted' || !t.facilitator_id) continue;
    if (t.kind === 'offline_sale') get(t.facilitator_id).offline_owed_centavos += t.facilitator_share_centavos ?? 0;
    if (t.kind === 'facilitator_payment') get(t.facilitator_id).paid_offline_centavos += t.amount_centavos;
  }
  for (const b of out.values()) {
    b.net_owed_centavos =
      b.unbatched_centavos + b.batched_unpaid_centavos + b.offline_owed_centavos - b.clawback_due_centavos - b.paid_offline_centavos;
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  kind: 'bank' | 'ewallet' | 'cash' | 'paymongo';
  opening_balance_centavos: number;
  opening_date: string;
  receives_paymongo: boolean;
  default_for_payouts: boolean;
  is_active: boolean;
}

export interface Movement {
  account_id: string;
  date: string; // YYYY-MM-DD, Manila
  amount_centavos: number; // signed
  label: string;
  source: string;
  source_id: string | null;
  /** Date inferred rather than recorded (PayMongo payouts). */
  approximate?: boolean;
}

export interface MovementInput {
  accounts: Account[];
  transactions: FinanceTransaction[];
  expenses: (ExpenseRow & { account_id: string | null })[];
  reimbursements: { id: string; payee: string; status: string; paid_at: string | null; account_id: string | null; total_centavos: number }[];
  payouts: (PaidPayoutRow & { account_id: string | null })[];
  ledger: { paymongo_payment_id: string; net_centavos: number | null; paid_at: string | null; payout_id: string | null; is_test: boolean }[];
}

/**
 * Every movement the books know about, per account.
 *
 * PayMongo money lands in the PayMongo account (if one is set up) when paid,
 * then leaves it for the account flagged `receives_paymongo` as one transfer
 * per PayMongo payout — dated on the last payment in it, because the payout's
 * own date is not captured. That is close enough for month-end matching and
 * flagged `approximate` so the screen can say so.
 */
export function accountMovements(i: MovementInput): Movement[] {
  const m: Movement[] = [];
  const paymongo = i.accounts.find((a) => a.kind === 'paymongo');
  const receiver = i.accounts.find((a) => a.receives_paymongo);
  const payoutAccount = i.accounts.find((a) => a.default_for_payouts);

  for (const t of i.transactions) {
    if (t.status !== 'posted') continue;
    const label = [t.kind.replace(/_/g, ' '), t.counterparty, t.item].filter(Boolean).join(' — ');
    if (t.account_id) {
      m.push({ account_id: t.account_id, date: t.occurred_on, amount_centavos: TRANSACTION_DIRECTION[t.kind] * t.amount_centavos, label, source: 'finance_transactions', source_id: t.id });
    }
    if (t.kind === 'transfer' && t.counter_account_id) {
      m.push({ account_id: t.counter_account_id, date: t.occurred_on, amount_centavos: t.amount_centavos, label, source: 'finance_transactions', source_id: t.id });
    }
  }
  for (const e of i.expenses) {
    if (e.status !== 'approved' || e.paid_by.toLowerCase() !== 'company' || !e.account_id) continue;
    m.push({ account_id: e.account_id, date: e.incurred_on, amount_centavos: -e.amount_centavos, label: `expense — ${e.vendor}`, source: 'expenses', source_id: e.id });
  }
  for (const r of i.reimbursements) {
    if (r.status !== 'paid' || !r.paid_at || !r.account_id) continue;
    m.push({ account_id: r.account_id, date: manilaDate(r.paid_at), amount_centavos: -r.total_centavos, label: `reimbursement — ${r.payee}`, source: 'reimbursements', source_id: r.id });
  }
  for (const p of i.payouts) {
    const acct = p.account_id ?? payoutAccount?.id;
    if (p.status !== 'paid' || !p.paid_at || !acct) continue;
    m.push({ account_id: acct, date: manilaDate(p.paid_at), amount_centavos: -p.net_centavos, label: 'facilitator payout batch', source: 'facilitator_payouts', source_id: p.id });
  }
  const groups = new Map<string, { net: number; last: string }>();
  for (const l of i.ledger) {
    if (l.is_test || l.net_centavos === null || !l.paid_at) continue;
    if (paymongo) {
      m.push({ account_id: paymongo.id, date: manilaDate(l.paid_at), amount_centavos: l.net_centavos, label: 'PayMongo payment (net of fee)', source: 'payment_ledger', source_id: l.paymongo_payment_id });
    }
    if (l.payout_id) {
      const g = groups.get(l.payout_id) ?? { net: 0, last: l.paid_at };
      g.net += l.net_centavos;
      if (l.paid_at > g.last) g.last = l.paid_at;
      groups.set(l.payout_id, g);
    }
  }
  for (const [id, g] of groups) {
    const date = manilaDate(g.last);
    if (paymongo) m.push({ account_id: paymongo.id, date, amount_centavos: -g.net, label: `PayMongo payout ${id}`, source: 'paymongo_payout', source_id: id, approximate: true });
    if (receiver) m.push({ account_id: receiver.id, date, amount_centavos: g.net, label: `PayMongo payout ${id}`, source: 'paymongo_payout', source_id: id, approximate: true });
  }
  return m.sort((a, b) => a.date.localeCompare(b.date));
}

/** Book balance at the end of `day` (inclusive): opening plus movements from the opening date on. */
export function balanceAt(account: Account, movements: Movement[], day: string): number {
  return (
    account.opening_balance_centavos +
    movements
      .filter((x) => x.account_id === account.id && x.date >= account.opening_date && x.date <= day)
      .reduce((s, x) => s + x.amount_centavos, 0)
  );
}

/** Last calendar day of 'YYYY-MM'. */
export function monthEndDay(month: string): string {
  const [y, mo] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

export interface StatementBalance {
  account_id: string;
  period: string; // YYYY-MM-01
  statement_balance_centavos: number;
}

export function accountExceptions(
  accounts: Account[],
  movements: Movement[],
  statements: StatementBalance[],
  balances: FacilitatorBalance[],
  facilitatorName: (id: string) => string,
): FinanceException[] {
  const out: FinanceException[] = [];
  for (const s of statements) {
    const a = accounts.find((x) => x.id === s.account_id);
    if (!a) continue;
    const month = s.period.slice(0, 7);
    const book = balanceAt(a, movements, monthEndDay(month));
    const gap = s.statement_balance_centavos - book;
    if (gap === 0) continue;
    out.push({
      key: `account_gap:${a.id}:${month}:${gap}`,
      kind: 'account_gap',
      severity: Math.abs(gap) >= 100000 ? 'high' : 'medium',
      title: `${a.name} doesn't match its ${month} statement`,
      detail: `The statement says ${peso(s.statement_balance_centavos)}; the books say ${peso(book)}. ${peso(Math.abs(gap))} ${
        gap > 0 ? 'more is in the account than recorded — an unrecorded receipt?' : 'less is in the account than recorded — an unrecorded payment or bank fee?'
      }`,
      amount_centavos: gap,
      link: { source: 'accounts', id: a.id },
    });
  }
  for (const b of balances) {
    if (b.net_owed_centavos >= 0) continue;
    out.push({
      key: `facilitator_credit:${b.facilitator_id}:${b.net_owed_centavos}`,
      kind: 'facilitator_credit',
      severity: 'low',
      title: `${facilitatorName(b.facilitator_id)} has been paid ahead`,
      detail: `Offline payments exceed what is owed by ${peso(-b.net_owed_centavos)}. It carries forward as a credit against future earnings.`,
      amount_centavos: -b.net_owed_centavos,
      link: { source: 'facilitators', id: b.facilitator_id },
    });
  }
  return out;
}

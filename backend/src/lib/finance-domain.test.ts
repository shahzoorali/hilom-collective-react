import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  manilaMonth,
  monthBounds,
  previousMonth,
  feeVatCentavos,
  looksLikeTestPayment,
  pickRule,
  resolveSplit,
  validateRuleInput,
  buildPnl,
  facilitatorPayables,
  detectExceptions,
  refundShares,
  assertPeriodOpen,
  type RevenueLine,
  type RefundLine,
  type SplitRule,
  type ExpenseRow,
} from './finance-domain.js';

/** A paid line; defaults are an October incense seat on Batara's flat deal. */
const line = (over: Partial<RevenueLine> = {}): RevenueLine => ({
  source: 'registration_charges',
  source_id: 'c1',
  parent_id: 'r1',
  occurred_at: '2026-10-12T04:21:00Z',
  service_date: '2026-10-17T02:00:00Z',
  buyer_name: 'Buyer',
  buyer_email: 'buyer@example.com',
  item: 'Incense Workshop',
  category: 'Workshop / Event',
  facilitator_id: 'f-batara',
  event_id: 'e-incense',
  gross_centavos: 250000,
  hilom_share_centavos: 100000,
  facilitator_share_centavos: 150000,
  split_missing: false,
  paymongo_payment_id: 'pay_1',
  source_status: 'paid',
  payout_id: null,
  clawed_back_payout_id: null,
  fee_centavos: 3750,
  is_test: false,
  ...over,
});

const refund = (over: Partial<RefundLine> = {}): RefundLine => ({
  source: 'event_registrations',
  source_id: 'r1',
  buyer_email: 'buyer@example.com',
  item: 'Incense Workshop',
  facilitator_id: 'f-batara',
  refund_centavos: 250000,
  refunded_at: null,
  decided_at: '2026-10-14T00:00:00Z',
  paymongo_payment_id: 'pay_1',
  ...over,
});

const expense = (over: Partial<ExpenseRow> = {}): ExpenseRow => ({
  id: 'x1',
  incurred_on: '2026-10-10',
  vendor: 'Kapitolyo Art Space',
  description: 'Venue',
  category: 'Venue / Event Cost',
  amount_centavos: 600000,
  paid_by: 'Crizy',
  receipt_key: null,
  reimbursement_id: null,
  status: 'approved',
  ...over,
});

const rule = (over: Partial<SplitRule> = {}): SplitRule => ({
  id: 'rule1',
  scope: 'event',
  scope_id: 'e-incense',
  kind: 'flat_per_seat',
  bps: null,
  flat_facilitator_centavos: 150000,
  fee_borne_by: 'hilom',
  ...over,
});

describe('dates', () => {
  test('months are Manila calendar months', () => {
    // 16:30 UTC on Sep 30 is already Oct 1 in Manila.
    assert.equal(manilaMonth('2026-09-30T16:30:00Z'), '2026-10');
    assert.equal(manilaMonth('2026-09-30T15:59:00Z'), '2026-09');
  });
  test('month bounds are Manila midnights', () => {
    assert.deepEqual(monthBounds('2026-10'), { start: '2026-09-30T16:00:00.000Z', end: '2026-10-31T16:00:00.000Z' });
    assert.equal(previousMonth('2026-01'), '2025-12');
  });
});

describe('fees and tests', () => {
  test('VAT is 12/112 of the inclusive fee', () => {
    assert.equal(feeVatCentavos(3750), 402);
  });
  test('a real ₱1 payment is not a test; a ₱1 "TEST" or admin payment is', () => {
    assert.equal(looksLikeTestPayment({ grossCentavos: 100, name: 'Khia Jeruta', email: 'k@x.com', testEmails: [] }), null);
    assert.ok(looksLikeTestPayment({ grossCentavos: 100, name: 'Crizy Austria - Testing', email: null, testEmails: [] }));
    assert.ok(looksLikeTestPayment({ grossCentavos: 2000, name: 'X', email: 'Admin@x.com', testEmails: ['admin@x.com'] }));
    assert.equal(looksLikeTestPayment({ grossCentavos: 2500, name: 'TEST', email: null, testEmails: [] }), null);
  });
});

describe('split rules', () => {
  test('event rule beats series beats facilitator', () => {
    const rules = [
      rule({ id: 'f', scope: 'facilitator', scope_id: 'fac' }),
      rule({ id: 's', scope: 'event_series', scope_id: 'ser' }),
      rule({ id: 'e', scope: 'event', scope_id: 'ev' }),
    ];
    assert.equal(pickRule(rules, { eventId: 'ev', seriesId: 'ser', facilitatorId: 'fac' })?.id, 'e');
    assert.equal(pickRule(rules, { eventId: 'other', seriesId: 'ser', facilitatorId: 'fac' })?.id, 's');
    assert.equal(pickRule(rules, { eventId: 'other', seriesId: null, facilitatorId: 'fac' })?.id, 'f');
    assert.equal(pickRule(rules, { eventId: 'other', seriesId: null, facilitatorId: null }), null);
  });
  test('flat per seat pays the flat amount, capped at the charge', () => {
    assert.deepEqual(resolveSplit(250000, rule(), null), { platformFeeCentavos: 100000, facilitatorNetCentavos: 150000, ruleId: 'rule1' });
    assert.equal(resolveSplit(100000, rule(), null)?.facilitatorNetCentavos, 100000);
  });
  test('percent rule overrides the event bps; hilom_owned and no-bps mean no split', () => {
    assert.equal(resolveSplit(100000, rule({ kind: 'percent_fee', bps: 0 }), 1500)?.platformFeeCentavos, 0);
    assert.equal(resolveSplit(100000, null, 1500)?.platformFeeCentavos, 15000);
    assert.equal(resolveSplit(100000, rule({ kind: 'hilom_owned' }), 1500), null);
    assert.equal(resolveSplit(100000, null, null), null);
  });
  test('rule input validation', () => {
    const id = '46e3e726-3f10-4292-9caf-e36702c97bae';
    assert.equal(validateRuleInput({ scope: 'event', scope_id: id, kind: 'percent_fee', bps: 1500 }), null);
    assert.ok(validateRuleInput({ scope: 'event', scope_id: id, kind: 'percent_fee', bps: 15.5 }));
    assert.ok(validateRuleInput({ scope: 'nope', scope_id: id, kind: 'hilom_owned' }));
    assert.ok(validateRuleInput({ scope: 'event', scope_id: id, kind: 'flat_per_seat' }));
  });
});

describe('refund shares', () => {
  test('a refund reverses the split in proportion', () => {
    const s = refundShares([line()], [refund({ refund_centavos: 125000 })]);
    assert.deepEqual(s.get('event_registrations:r1'), { hilom: 50000, facilitator: 75000, gross: 125000, serviceDate: '2026-10-17T02:00:00Z' });
  });
});

describe('buildPnl', () => {
  const base = {
    lines: [
      line(),
      line({ source_id: 'c2', parent_id: 'r2', paymongo_payment_id: 'pay_2' }),
      line({ source_id: 'c3', parent_id: 'r3', is_test: true, gross_centavos: 100, hilom_share_centavos: 100, facilitator_share_centavos: 0 }),
    ],
    refunds: [] as RefundLine[],
    expenses: [expense()],
    adjustments: [],
    payouts: [],
  };

  test('October, accrual: Hilom share less fees less venue', () => {
    const p = buildPnl({ ...base, month: '2026-10', basis: 'accrual' });
    assert.equal(p.gross_sales, 500000);
    assert.equal(p.hilom_share, 200000);
    assert.equal(p.facilitator_share, 300000);
    assert.equal(p.paymongo_fees, 7500);
    assert.equal(p.gross_profit, 192500);
    assert.equal(p.opex_total, 600000);
    assert.equal(p.net_profit, -407500);
    assert.equal(p.sales_count, 2, 'test payments are excluded by default');
  });

  test('accrual vs cash: a September payment for an October event', () => {
    const lines = [line({ occurred_at: '2026-09-20T02:00:00Z' })];
    assert.equal(buildPnl({ ...base, lines, month: '2026-09', basis: 'cash' }).hilom_share, 100000);
    assert.equal(buildPnl({ ...base, lines, month: '2026-09', basis: 'accrual' }).hilom_share, 0);
    assert.equal(buildPnl({ ...base, lines, month: '2026-10', basis: 'accrual' }).hilom_share, 100000);
  });

  test('refunds: accrual when decided, cash only once sent', () => {
    const refunds = [refund()];
    assert.equal(buildPnl({ ...base, refunds, month: '2026-10', basis: 'accrual' }).refunds_hilom, 100000);
    assert.equal(buildPnl({ ...base, refunds, month: '2026-10', basis: 'cash' }).refunds_hilom, 0);
    const sent = [refund({ refunded_at: '2026-10-15T00:00:00Z' })];
    assert.equal(buildPnl({ ...base, refunds: sent, month: '2026-10', basis: 'cash' }).refunds_hilom, 100000);
  });

  test('unknown fees are counted, not guessed', () => {
    const p = buildPnl({ ...base, lines: [line({ fee_centavos: null })], month: '2026-10', basis: 'accrual' });
    assert.equal(p.paymongo_fees, 0);
    assert.equal(p.fees_unknown_count, 1);
  });

  test('adjustments and recovered processing fees', () => {
    const p = buildPnl({
      ...base,
      month: '2026-10',
      basis: 'accrual',
      adjustments: [
        { id: 'a', period: '2026-10-01', line: 'revenue', amount_centavos: 1000, reason: 'r', voided_at: null },
        { id: 'b', period: '2026-10-01', line: 'opex', amount_centavos: -500, reason: 'r', voided_at: null },
        { id: 'c', period: '2026-10-01', line: 'revenue', amount_centavos: 99999, reason: 'void', voided_at: '2026-10-02' },
      ],
      payouts: [{ id: 'p', facilitator_id: 'f', status: 'paid', paid_at: '2026-10-05T00:00:00Z', processing_fee_centavos: 375, net_centavos: 1 }],
    });
    assert.equal(p.revenue_adjustments, 1000);
    assert.equal(p.fees_recovered, 375);
    assert.equal(p.opex_total, 600500);
  });
});

describe('payables', () => {
  test('unbatched, batched and clawback due', () => {
    const lines = [
      line({ source_id: 'a', parent_id: 'ra' }),
      line({ source_id: 'b', parent_id: 'rb', payout_id: 'p-draft' }),
      line({ source_id: 'c', parent_id: 'rc', payout_id: 'p-paid' }),
      line({ source_id: 'd', parent_id: 'rd' }), // refunded before any payout: not owed
    ];
    const refunds = [refund({ source_id: 'rc' }), refund({ source_id: 'rd' })];
    const [p] = facilitatorPayables(lines, refunds, new Map([['p-draft', 'draft'], ['p-paid', 'paid']]));
    assert.equal(p!.unbatched_centavos, 150000);
    assert.equal(p!.batched_unpaid_centavos, 150000);
    assert.equal(p!.clawback_due_centavos, 150000);
  });
});

describe('detectExceptions', () => {
  const run = (over: Partial<Parameters<typeof detectExceptions>[0]> = {}) =>
    detectExceptions({
      lines: [],
      refunds: [],
      ledger: [],
      expenses: [],
      payoutStatus: new Map(),
      closedPeriods: [],
      reimbursementsOwed: [],
      today: '2026-10-15',
      ...over,
    });

  test('refund owed (the Milan case)', () => {
    const ex = run({ refunds: [refund({ refund_centavos: 55500 })] });
    assert.equal(ex[0]!.kind, 'refund_owed');
    assert.equal(ex[0]!.amount_centavos, 55500);
  });

  test('duplicate charge four minutes apart (the Tamayo case), but not instalments', () => {
    const lines = [
      line({ source_id: 'a', parent_id: 'ra', occurred_at: '2026-10-13T09:21:00Z', paymongo_payment_id: null }),
      line({ source_id: 'b', parent_id: 'rb', occurred_at: '2026-10-13T09:25:00Z', paymongo_payment_id: null }),
      line({ source_id: 'c', parent_id: 'rc', occurred_at: '2026-10-13T08:00:00Z', buyer_email: 'other@x.com', paymongo_payment_id: null }),
      line({ source_id: 'd', parent_id: 'rc', occurred_at: '2026-10-13T08:01:00Z', buyer_email: 'other@x.com', paymongo_payment_id: null }),
    ];
    const ex = run({ lines }).filter((e) => e.kind === 'duplicate_charge');
    assert.equal(ex.length, 1);
    assert.equal(ex[0]!.key, 'duplicate_charge:a:b');
  });

  test('missing fee, orphan payment, missing split grouped per event', () => {
    const lines = [
      line({ split_missing: true, paymongo_payment_id: 'pay_x' }),
      line({ source_id: 'c2', parent_id: 'r2', split_missing: true, paymongo_payment_id: 'pay_y' }),
    ];
    const ex = run({
      lines,
      ledger: [
        { paymongo_payment_id: 'pay_y', source_table: 'registration_charges', gross_centavos: 250000, fee_centavos: 3750, fetch_error: null, is_test: false },
        { paymongo_payment_id: 'pay_z', source_table: 'unknown', gross_centavos: 2000, fee_centavos: 30, fetch_error: null, is_test: false },
      ],
    });
    assert.equal(ex.filter((e) => e.kind === 'fee_missing').length, 1);
    assert.equal(ex.filter((e) => e.kind === 'ledger_orphan').length, 1);
    const split = ex.filter((e) => e.kind === 'split_missing');
    assert.equal(split.length, 1);
    assert.equal(split[0]!.amount_centavos, 500000);
  });

  test('future-dated expense and no receipt; drafts ignored', () => {
    const ex = run({ expenses: [expense({ incurred_on: '2026-10-16' }), expense({ id: 'x2', status: 'draft' })] });
    assert.deepEqual(ex.map((e) => e.kind).sort(), ['expense_future', 'expense_no_receipt']);
  });

  test('closed period drift and sorting by severity', () => {
    const ex = run({
      closedPeriods: [{ month: '2026-09', snapshotNet: 100, currentNet: 50 }],
      reimbursementsOwed: [{ id: 'r', payee: 'Crizy', total_centavos: 1000 }],
    });
    assert.deepEqual(ex.map((e) => e.kind), ['closed_period_changed', 'reimbursement_owed']);
  });
});

describe('period lock', () => {
  test('closed months refuse writes', () => {
    assert.ok(assertPeriodOpen('2026-09', new Set(['2026-09'])));
    assert.equal(assertPeriodOpen('2026-10', new Set(['2026-09'])), null);
  });
});

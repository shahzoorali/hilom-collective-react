import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
} from './finance-accounts.js';
import { buildPnl } from './finance-domain.js';

const tx = (over: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id: 't1',
  occurred_on: '2026-10-05',
  kind: 'offline_sale',
  amount_centavos: 100000,
  account_id: 'cash',
  counter_account_id: null,
  counterparty: 'Walk-in',
  counterparty_email: null,
  item: 'Saturday HIIT (cash)',
  category: 'Group Class',
  facilitator_id: 'prem',
  event_id: null,
  hilom_share_centavos: 15000,
  facilitator_share_centavos: 85000,
  reference: null,
  status: 'posted',
  created_at: '2026-10-05T00:00:00Z',
  ...over,
});

const acct = (over: Partial<Account> = {}): Account => ({
  id: 'bank',
  name: 'BDO',
  kind: 'bank',
  opening_balance_centavos: 1000000,
  opening_date: '2026-09-01',
  receives_paymongo: true,
  default_for_payouts: true,
  is_active: true,
  ...over,
});

describe('offline sales', () => {
  test('split precedence: explicit, event, facilitator rate, Hilom', () => {
    assert.deepEqual(offlineSplit(100000, { explicitHilomCentavos: 40000, facilitatorBps: 1500 }), { hilom: 40000, facilitator: 60000 });
    assert.deepEqual(offlineSplit(250000, { useEventSplit: true, eventSplit: { platformFeeCentavos: 100000, facilitatorNetCentavos: 150000, ruleId: 'r' } }), { hilom: 100000, facilitator: 150000 });
    assert.deepEqual(offlineSplit(250000, { useEventSplit: true, eventSplit: null, facilitatorBps: 1500 }), { hilom: 250000, facilitator: 0 });
    assert.deepEqual(offlineSplit(100000, { facilitatorBps: 1500 }), { hilom: 15000, facilitator: 85000 });
    assert.deepEqual(offlineSplit(100000, {}), { hilom: 100000, facilitator: 0 });
  });

  test('an offline sale lands in the P&L month it happened, with no fee', () => {
    const p = buildPnl({ month: '2026-10', basis: 'cash', lines: [offlineSaleLine(tx())], refunds: [], expenses: [], adjustments: [], payouts: [] });
    assert.equal(p.gross_sales, 100000);
    assert.equal(p.hilom_share, 15000);
    assert.equal(p.paymongo_fees, 0);
    assert.equal(p.fees_unknown_count, 0);
  });

  test('input validation', () => {
    const ok = { kind: 'offline_sale', occurred_on: '2026-10-05', amount_centavos: 100, item: 'x' };
    assert.equal(validateTransactionInput(ok), null);
    assert.ok(validateTransactionInput({ ...ok, item: '' }));
    assert.ok(validateTransactionInput({ ...ok, kind: 'facilitator_payment' }));
    assert.ok(validateTransactionInput({ ...ok, kind: 'transfer', account_id: 'a', counter_account_id: 'a' }));
    assert.ok(validateTransactionInput({ ...ok, amount_centavos: 0 }));
  });
});

describe('facilitator balances', () => {
  test('offline share owed, offline payment settles it, overpayment is credit', () => {
    const txs = [tx(), tx({ id: 't2', kind: 'facilitator_payment', amount_centavos: 100000, item: null, hilom_share_centavos: null, facilitator_share_centavos: null })];
    const [b] = facilitatorBalances([offlineSaleLine(txs[0]!)], [], new Map(), txs);
    assert.equal(b!.offline_owed_centavos, 85000);
    assert.equal(b!.unbatched_centavos, 0, 'offline sales are not batchable platform shares');
    assert.equal(b!.paid_offline_centavos, 100000);
    assert.equal(b!.net_owed_centavos, -15000);
    const ex = accountExceptions([], [], [], [b!], () => 'Prem');
    assert.equal(ex[0]!.kind, 'facilitator_credit');
  });

  test('a payment to a facilitator with no sales recorded is still tracked (historic transfer)', () => {
    const [b] = facilitatorBalances([], [], new Map(), [tx({ kind: 'facilitator_payment', facilitator_id: 'batara', amount_centavos: 3150000 })]);
    assert.equal(b!.facilitator_id, 'batara');
    assert.equal(b!.net_owed_centavos, -3150000);
  });
});

describe('accounts', () => {
  const accounts = [acct(), acct({ id: 'cash', name: 'Cash box', kind: 'cash', receives_paymongo: false, default_for_payouts: false, opening_balance_centavos: 0 }), acct({ id: 'pm', name: 'PayMongo', kind: 'paymongo', receives_paymongo: false, default_for_payouts: false, opening_balance_centavos: 0 })];
  const movements = accountMovements({
    accounts,
    transactions: [
      tx(), // +1000 cash
      tx({ id: 'tr', kind: 'transfer', account_id: 'cash', counter_account_id: 'bank', amount_centavos: 50000 }),
      tx({ id: 'w', kind: 'owner_withdrawal', account_id: 'bank', amount_centavos: 20000 }),
      tx({ id: 'v', kind: 'owner_contribution', account_id: 'bank', amount_centavos: 999999, status: 'void' }),
    ],
    expenses: [
      { id: 'e', incurred_on: '2026-10-06', vendor: 'Google', description: '', category: 'Other', amount_centavos: 10000, paid_by: 'company', receipt_key: null, reimbursement_id: null, status: 'approved', account_id: 'bank' },
      { id: 'e2', incurred_on: '2026-10-06', vendor: 'Venue', description: '', category: 'Other', amount_centavos: 10000, paid_by: 'Crizy', receipt_key: null, reimbursement_id: null, status: 'approved', account_id: 'bank' },
    ],
    reimbursements: [{ id: 'r', payee: 'Crizy', status: 'paid', paid_at: '2026-10-07T02:00:00Z', account_id: 'bank', total_centavos: 10000 }],
    payouts: [{ id: 'p', facilitator_id: 'f', status: 'paid', paid_at: '2026-10-08T02:00:00Z', processing_fee_centavos: 0, net_centavos: 30000, account_id: null }],
    ledger: [
      { paymongo_payment_id: 'pay_1', net_centavos: 24625, paid_at: '2026-10-02T02:00:00Z', payout_id: 'po_1', is_test: false },
      { paymongo_payment_id: 'pay_2', net_centavos: 9850, paid_at: '2026-10-09T02:00:00Z', payout_id: null, is_test: false },
      { paymongo_payment_id: 'pay_t', net_centavos: 98, paid_at: '2026-10-09T02:00:00Z', payout_id: null, is_test: true },
    ],
  });

  test('balances follow every movement; voids, personal expenses and tests do not move money', () => {
    // bank: 10,000 + 500 transfer − 200 withdrawal − 100 expense − 100 reimbursement − 300 payout + 246.25 PayMongo payout
    assert.equal(balanceAt(accounts[0]!, movements, '2026-10-31'), 1000000 + 50000 - 20000 - 10000 - 10000 - 30000 + 24625);
    assert.equal(balanceAt(accounts[1]!, movements, '2026-10-31'), 100000 - 50000);
    // PayMongo holds only what has not been paid out yet
    assert.equal(balanceAt(accounts[2]!, movements, '2026-10-31'), 9850);
    assert.equal(balanceAt(accounts[1]!, movements, '2026-10-04'), 0, 'before the sale');
  });

  test('statement mismatch raises a gap; a match does not', () => {
    const book = balanceAt(accounts[0]!, movements, monthEndDay('2026-10'));
    assert.equal(accountExceptions(accounts, movements, [{ account_id: 'bank', period: '2026-10-01', statement_balance_centavos: book }], [], () => '').length, 0);
    const ex = accountExceptions(accounts, movements, [{ account_id: 'bank', period: '2026-10-01', statement_balance_centavos: book - 2500 }], [], () => '');
    assert.equal(ex[0]!.kind, 'account_gap');
    assert.equal(ex[0]!.amount_centavos, -2500);
  });

  test('month end', () => {
    assert.equal(monthEndDay('2026-02'), '2026-02-28');
    assert.equal(monthEndDay('2026-10'), '2026-10-31');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpenseDraft, matchOne, type DraftContext } from './expense-draft.js';

const ctx = (over: Partial<DraftContext> = {}): DraftContext => ({
  today: '2026-10-17',
  accounts: [
    { id: 'a-bdo', name: 'BDO Current', is_active: true },
    { id: 'a-gcash', name: 'GCash', is_active: true },
    { id: 'a-old', name: 'Old BPI', is_active: false },
  ],
  events: [
    { id: 'e1', title: 'Filipino Incense Making Workshop with Batara', starts_at: '2026-10-17T02:00:00Z' },
    { id: 'e2', title: 'Monday: Online HIIT Pilates Express with Prem', starts_at: '2026-10-20T00:00:00Z' },
    { id: 'e3', title: 'Wednesday: Online HIIT Pilates Express with Prem', starts_at: '2026-10-22T00:00:00Z' },
  ],
  closedMonths: new Set(['2026-08']),
  recentExpenses: [{ id: 'x1', incurred_on: '2026-09-23', vendor: 'Kapitolyo Art Space', amount_centavos: 650000, status: 'approved' }],
  ...over,
});

const full = {
  incurred_on: '2026-10-16',
  vendor: 'Kapitolyo Art Space',
  description: 'Venue for Oct 17 incense workshop',
  category: 'venue',
  amount_php: '₱6,000',
  account: 'gcash',
  event: 'incense',
};

describe('validateExpenseDraft', () => {
  test('a complete message becomes a ready draft, with fuzzy category/account/event resolved', () => {
    const r = validateExpenseDraft(full, ctx());
    assert.equal(r.status, 'ready', r.questions.join(' | '));
    assert.equal(r.draft.category, 'Venue / Event Cost');
    assert.equal(r.draft.amount_centavos, 600000);
    assert.equal(r.draft.account_id, 'a-gcash');
    assert.equal(r.draft.paid_by, 'company');
    assert.equal(r.draft.event_id, 'e1');
  });

  test('missing fields become questions, nothing is guessed', () => {
    const r = validateExpenseDraft({ vendor: 'DTI' }, ctx());
    assert.equal(r.status, 'needs_info');
    assert.equal(r.questions.length, 4); // date, category, amount, who paid
    assert.equal(r.draft.amount_centavos, undefined);
  });

  test('paid personally makes it a reimbursement, no account', () => {
    const r = validateExpenseDraft({ ...full, account: undefined, paid_by_person: 'Crizy' }, ctx());
    assert.equal(r.status, 'ready');
    assert.equal(r.draft.paid_by, 'Crizy');
    assert.equal(r.draft.account_id, null);
    assert.ok(r.warnings.some((w) => w.includes('owes Crizy')));
  });

  test('both an account and a person is ambiguous', () => {
    const r = validateExpenseDraft({ ...full, paid_by_person: 'Crizy' }, ctx());
    assert.equal(r.status, 'needs_info');
  });

  test('closed month blocks; future date only warns', () => {
    assert.equal(validateExpenseDraft({ ...full, incurred_on: '2026-08-30' }, ctx()).status, 'needs_info');
    const f = validateExpenseDraft({ ...full, incurred_on: '2026-10-30' }, ctx());
    assert.equal(f.status, 'ready');
    assert.ok(f.warnings.some((w) => w.includes('future')));
  });

  test('bad inputs: unknown category, zero amount, VAT over amount, bad date, inactive account', () => {
    assert.ok(validateExpenseDraft({ ...full, category: 'snacks' }, ctx()).questions.some((q) => q.includes('categories')));
    assert.equal(validateExpenseDraft({ ...full, amount_php: 0 }, ctx()).status, 'needs_info');
    assert.equal(validateExpenseDraft({ ...full, vat_php: 7000 }, ctx()).status, 'needs_info');
    assert.equal(validateExpenseDraft({ ...full, incurred_on: '16/10/2026' }, ctx()).status, 'needs_info');
    assert.equal(validateExpenseDraft({ ...full, account: 'Old BPI' }, ctx()).status, 'needs_info');
  });

  test('ambiguous event asks which one', () => {
    const r = validateExpenseDraft({ ...full, event: 'HIIT Pilates' }, ctx());
    assert.equal(r.status, 'needs_info');
    assert.ok(r.questions[0]!.includes('Monday') && r.questions[0]!.includes('Wednesday'));
  });

  test('flags a likely duplicate but does not block', () => {
    const r = validateExpenseDraft({ ...full, incurred_on: '2026-09-25', amount_php: 6500 }, ctx());
    assert.equal(r.status, 'ready');
    assert.ok(r.warnings.some((w) => w.startsWith('Possible duplicate')));
  });

  test('no accounts set up: company-paid is allowed with a warning', () => {
    const r = validateExpenseDraft(full, ctx({ accounts: [] }));
    assert.equal(r.status, 'ready');
    assert.equal(r.draft.account_id, null);
  });
});

describe('matchOne', () => {
  test('exact beats partial; id works', () => {
    const items = [{ id: '1', n: 'GCash' }, { id: '2', n: 'GCash Business' }];
    assert.equal(matchOne('gcash', items, (i) => i.n).match?.id, '1');
    assert.equal(matchOne('2', items, (i) => i.n, (i) => i.id).match?.id, '2');
    assert.equal(matchOne('cash', items, (i) => i.n).match, null);
  });
});

/** Package instalments (Canny: Group Packages – Installment Payments). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInstallmentPlan, suggestInstallmentPlan, chargesForPlan, chargeDueAt, reminderTierFor, chargeState,
} from './package-installments.js';

describe('validateInstallmentPlan', () => {
  const ok = [{ amount_centavos: 1_000_000, due_session: 1 }, { amount_centavos: 1_500_000, due_session: 3 }];
  it('accepts a plan that adds up, starts at session 1 and is in order', () => {
    assert.ok(validateInstallmentPlan(ok, 2_500_000, 6).ok);
  });
  it('treats null or an empty list as full payment only', () => {
    assert.deepEqual(validateInstallmentPlan(null, 100, 6), { ok: true, plan: [] });
    assert.deepEqual(validateInstallmentPlan([], 100, 6), { ok: true, plan: [] });
  });
  it('refuses a total that does not match the price', () => {
    assert.equal(validateInstallmentPlan(ok, 2_400_000, 6).ok, false);
  });
  it('refuses a first payment not at checkout, out-of-order or out-of-range sessions', () => {
    assert.equal(validateInstallmentPlan([{ amount_centavos: 1, due_session: 2 }, { amount_centavos: 1, due_session: 3 }], 2, 6).ok, false);
    assert.equal(validateInstallmentPlan([{ amount_centavos: 1, due_session: 1 }, { amount_centavos: 1, due_session: 7 }], 2, 6).ok, false);
    assert.equal(validateInstallmentPlan([{ amount_centavos: 1, due_session: 1 }, { amount_centavos: 1, due_session: 4 }, { amount_centavos: 1, due_session: 2 }], 3, 6).ok, false);
  });
  it('refuses a single payment or zero amounts', () => {
    assert.equal(validateInstallmentPlan([{ amount_centavos: 100, due_session: 1 }], 100, 6).ok, false);
    assert.equal(validateInstallmentPlan([{ amount_centavos: 0, due_session: 1 }, { amount_centavos: 100, due_session: 2 }], 100, 6).ok, false);
  });
});

describe('suggestInstallmentPlan', () => {
  it('splits evenly, sums to the price and spaces due sessions', () => {
    const p = suggestInstallmentPlan(2_500_000, 6, 3);
    assert.equal(p.reduce((s, x) => s + x.amount_centavos, 0), 2_500_000);
    assert.deepEqual(p.map((x) => x.due_session), [1, 3, 5]);
    assert.ok(validateInstallmentPlan(p, 2_500_000, 6).ok);
  });
  it('never asks for more payments than sessions', () => {
    assert.equal(suggestInstallmentPlan(1000_00, 3, 6).length, 3);
  });
});

describe('chargesForPlan', () => {
  it('splits the platform fee so it adds back exactly', () => {
    const c = chargesForPlan([{ amount_centavos: 333_33, due_session: 1 }, { amount_centavos: 333_33, due_session: 2 }, { amount_centavos: 333_34, due_session: 3 }], 150_00);
    assert.equal(c.reduce((s, x) => s + x.platform_fee_centavos, 0), 150_00);
    for (const x of c) assert.equal(x.platform_fee_centavos + x.facilitator_net_centavos, x.amount_centavos);
    assert.equal(c[1]!.label, 'Payment 2 of 3');
  });
});

describe('chargeDueAt', () => {
  it('is the Nth session start, or null when not scheduled yet', () => {
    const starts = ['2026-12-01T02:00:00Z', '2026-12-08T02:00:00Z'];
    assert.equal(chargeDueAt(2, starts), '2026-12-08T02:00:00Z');
    assert.equal(chargeDueAt(3, starts), null);
  });
});

describe('reminderTierFor', () => {
  const due = new Date('2026-12-10T02:00:00Z'); // 10:00 Manila, Dec 10
  it('gives 7d, 3d and day-of at the right times, most urgent only', () => {
    assert.equal(reminderTierFor(due, new Date('2026-12-01T02:00:00Z')), null); // 9 days out
    assert.equal(reminderTierFor(due, new Date('2026-12-04T02:00:00Z')), '7d');
    assert.equal(reminderTierFor(due, new Date('2026-12-08T02:00:00Z')), '3d');
    assert.equal(reminderTierFor(due, new Date('2026-12-09T17:00:00Z')), 'day_of'); // 01:00 Manila Dec 10
    assert.equal(reminderTierFor(due, new Date('2026-12-10T03:00:00Z')), null); // session started
  });
});

describe('chargeState', () => {
  const now = new Date('2026-12-05T00:00:00Z');
  it('reports paid, pending and overdue', () => {
    assert.equal(chargeState('paid', null, now), 'paid');
    assert.equal(chargeState('scheduled', '2026-12-10T00:00:00Z', now), 'pending');
    assert.equal(chargeState('scheduled', null, now), 'pending');
    assert.equal(chargeState('awaiting_payment', '2026-12-01T00:00:00Z', now), 'overdue');
  });
});

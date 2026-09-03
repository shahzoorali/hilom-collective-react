/**
 * Tests for the booking money and policy rules.
 *
 * Same reasoning as slots.test.ts: `node:test` via tsx, no framework. These
 * are the decisions that decide what someone is charged and what a facilitator
 * is owed, so the assertions are on exact centavo amounts rather than shapes.
 *
 * Run with `npm run test` in backend/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitFee,
  refundForCancellation,
  canReschedule,
  resolveRefundPolicy,
  describeRefundPolicy,
  DEFAULT_REFUND_POLICY,
  RESCHEDULE_MIN_NOTICE_HOURS,
} from './booking-domain.js';

const NOW = new Date('2026-03-10T00:00:00Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe('splitFee — the platform cut', () => {
  it('splits a clean percentage exactly', () => {
    const fee = splitFee(150_000, 1500); // ₱1,500 at 15%
    assert.equal(fee.platformFeeCentavos, 22_500);
    assert.equal(fee.facilitatorNetCentavos, 127_500);
  });

  it('always sums back to the price, so nothing is created or lost', () => {
    for (const price of [1, 99, 100, 12_345, 150_000, 999_999]) {
      for (const bps of [0, 1, 750, 1500, 3333, 10_000]) {
        const fee = splitFee(price, bps);
        assert.equal(
          fee.platformFeeCentavos + fee.facilitatorNetCentavos,
          price,
          `split of ${price} at ${bps}bps did not sum back`,
        );
      }
    }
  });

  it('rounds the half-centavo to the facilitator, not the platform', () => {
    // 1 centavo at 50% is exactly half a centavo — it must not round to Hilom.
    const fee = splitFee(1, 5000);
    assert.equal(fee.platformFeeCentavos, 0);
    assert.equal(fee.facilitatorNetCentavos, 1);
  });

  it('clamps a nonsense rate rather than inverting the split', () => {
    assert.equal(splitFee(1000, -500).platformFeeCentavos, 0);
    assert.equal(splitFee(1000, 99_999).facilitatorNetCentavos, 0);
  });
});

describe('refundForCancellation — what the client gets back', () => {
  const price = 150_000;

  it('refunds in full at 24 hours or more', () => {
    const d = refundForCancellation({ priceCentavos: price, startsAt: hoursFromNow(24), now: NOW, cancelledBy: 'client' });
    assert.equal(d.refundCentavos, price);
  });

  it('refunds half between 12 and 24 hours', () => {
    const d = refundForCancellation({ priceCentavos: price, startsAt: hoursFromNow(13), now: NOW, cancelledBy: 'client' });
    assert.equal(d.refundCentavos, price / 2);
  });

  it('refunds nothing under 12 hours', () => {
    const d = refundForCancellation({ priceCentavos: price, startsAt: hoursFromNow(11), now: NOW, cancelledBy: 'client' });
    assert.equal(d.refundCentavos, 0);
  });

  it('refunds in full whenever the facilitator cancels, however late', () => {
    const d = refundForCancellation({ priceCentavos: price, startsAt: hoursFromNow(0.5), now: NOW, cancelledBy: 'facilitator' });
    assert.equal(d.refundCentavos, price);
  });

  it('has nothing to refund on a complimentary session', () => {
    const d = refundForCancellation({ priceCentavos: 0, startsAt: hoursFromNow(1), now: NOW, cancelledBy: 'client' });
    assert.equal(d.refundCentavos, 0);
  });
});

describe('canReschedule — moving a session must not undercut cancelling it', () => {
  it('allows a move at exactly the notice boundary', () => {
    const d = canReschedule({ startsAt: hoursFromNow(RESCHEDULE_MIN_NOTICE_HOURS), now: NOW });
    assert.equal(d.allowed, true);
  });

  it('allows a move comfortably ahead of the session', () => {
    assert.equal(canReschedule({ startsAt: hoursFromNow(72), now: NOW }).allowed, true);
  });

  /**
   * The bypass this rule exists to close: inside the free-cancellation window
   * a move must not be available, or it is strictly better than cancelling —
   * the slot is released either way, but nothing is paid for it.
   */
  it('refuses a move once cancelling would cost the client money', () => {
    for (const h of [23.9, 20, 13, 12, 6, 0.5]) {
      const d = canReschedule({ startsAt: hoursFromNow(h), now: NOW });
      assert.equal(d.allowed, false, `a move ${h}h out should be refused`);
      assert.match(d.reason, /cancel/i);
    }
  });

  it('agrees with the refund policy about where the free window ends', () => {
    // Anywhere a move is allowed, cancelling must already be free — otherwise
    // the move is the cheaper option and the policy is bypassable.
    for (const h of [24, 25, 48, 200]) {
      const moveOk = canReschedule({ startsAt: hoursFromNow(h), now: NOW }).allowed;
      const refund = refundForCancellation({
        priceCentavos: 150_000,
        startsAt: hoursFromNow(h),
        now: NOW,
        cancelledBy: 'client',
      }).refundCentavos;
      assert.equal(moveOk && refund === 150_000, true, `at ${h}h the two policies disagree`);
    }
  });

  it('applies to complimentary sessions too — the held hour is just as real', () => {
    assert.equal(canReschedule({ startsAt: hoursFromNow(2), now: NOW }).allowed, false);
  });
});

/**
 * The per-service policy (0027).
 *
 * The bug this closes: a facilitator could write "48 hours notice, no refunds
 * after" in free text and the platform would still refund in full at 25 hours.
 * These assert that the numbers are now the thing that decides.
 */
describe('per-service refund policies', () => {
  const price = 150_000;
  const strict = { fullHours: 48, halfHours: 48 };

  it('honours a stricter ladder than the default', () => {
    const at25 = refundForCancellation({
      priceCentavos: price, startsAt: hoursFromNow(25), now: NOW, cancelledBy: 'client', policy: strict,
    });
    // The old hardcoded ladder refunded this in full. The written policy said not to.
    assert.equal(at25.refundCentavos, 0);

    const at49 = refundForCancellation({
      priceCentavos: price, startsAt: hoursFromNow(49), now: NOW, cancelledBy: 'client', policy: strict,
    });
    assert.equal(at49.refundCentavos, price);
  });

  it('honours a fully permissive ladder', () => {
    const d = refundForCancellation({
      priceCentavos: price, startsAt: hoursFromNow(0.25), now: NOW, cancelledBy: 'client',
      policy: { fullHours: 0, halfHours: 0 },
    });
    assert.equal(d.refundCentavos, price);
  });

  it('still refunds in full when the facilitator cancels, whatever the policy', () => {
    const d = refundForCancellation({
      priceCentavos: price, startsAt: hoursFromNow(0.1), now: NOW, cancelledBy: 'facilitator', policy: strict,
    });
    assert.equal(d.refundCentavos, price);
  });

  it('moves the reschedule line with the full-refund line', () => {
    // At 30 hours a 48h-policy client cannot cancel for free, so they must not
    // be able to move either — that is the bypass canReschedule exists to close.
    assert.equal(canReschedule({ startsAt: hoursFromNow(30), now: NOW, policy: strict }).allowed, false);
    assert.equal(canReschedule({ startsAt: hoursFromNow(49), now: NOW, policy: strict }).allowed, true);
  });

  it('keeps move-allowed and cancel-free in agreement for any policy', () => {
    for (const policy of [
      DEFAULT_REFUND_POLICY,
      { fullHours: 0, halfHours: 0 },
      { fullHours: 48, halfHours: 24 },
      { fullHours: 72, halfHours: 0 },
      { fullHours: 6, halfHours: 6 },
    ]) {
      for (const h of [0, 1, 5.9, 6, 12, 23, 24, 47, 48, 71, 72, 100]) {
        const moveOk = canReschedule({ startsAt: hoursFromNow(h), now: NOW, policy }).allowed;
        const full = refundForCancellation({
          priceCentavos: price, startsAt: hoursFromNow(h), now: NOW, cancelledBy: 'client', policy,
        }).refundCentavos === price;
        assert.equal(moveOk, full, `at ${h}h under ${JSON.stringify(policy)} the two policies disagree`);
      }
    }
  });

  it('falls back to the pre-0027 ladder for a booking with no snapshot', () => {
    assert.deepEqual(resolveRefundPolicy({ fullHours: null, halfHours: null }), DEFAULT_REFUND_POLICY);
  });

  it('never resolves a backwards ladder, whatever is in the columns', () => {
    const p = resolveRefundPolicy({ fullHours: 12, halfHours: 48 });
    assert.equal(p.halfHours <= p.fullHours, true);
    const clamped = resolveRefundPolicy({ fullHours: -5, halfHours: 9_999 });
    assert.equal(clamped.fullHours, 0);
    assert.equal(clamped.halfHours, 0);
  });

  it('describes every shape of ladder without contradicting itself', () => {
    assert.match(describeRefundPolicy({ fullHours: 0, halfHours: 0 }), /any time/i);
    assert.match(describeRefundPolicy({ fullHours: 48, halfHours: 48 }), /not refundable/i);
    assert.doesNotMatch(describeRefundPolicy({ fullHours: 48, halfHours: 48 }), /half/i);
    assert.match(describeRefundPolicy({ fullHours: 24, halfHours: 12 }), /24 hours.*12 hours/s);
    assert.match(describeRefundPolicy({ fullHours: 1, halfHours: 1 }), /at least 1 hour /);
  });
});

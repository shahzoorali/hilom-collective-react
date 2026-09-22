import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTSTANDING_CHARGE_STATUSES,
  chargesOverdue,
  eventsAwaitingReview,
  facilitatorsAwaitingReview,
  isOutstanding,
  ordersNotFulfilled,
  refundOwed,
  reviewsAwaitingModeration,
  type QueueFilter,
} from './admin-queues.js';
import type { ChargeStatus } from './event-ticketing.js';

/**
 * A stand-in for the PostgREST builder that records what was asked of it.
 *
 * The point of these tests is not that supabase-js works — it is that the
 * dashboard's count and the screen's list apply the *same* filter. Recording
 * the calls is what lets a test assert the shape of a predicate without a
 * database, and what would catch somebody "fixing" one caller in place.
 */
type Call = [string, string, unknown];

class FakeQuery {
  readonly calls: Call[] = [];
  eq(column: string, value: unknown) {
    this.calls.push(['eq', column, value]);
    return this;
  }
  gt(column: string, value: unknown) {
    this.calls.push(['gt', column, value]);
    return this;
  }
  lt(column: string, value: unknown) {
    this.calls.push(['lt', column, value]);
    return this;
  }
  is(column: string, value: unknown) {
    this.calls.push(['is', column, value]);
    return this;
  }
  in(column: string, values: readonly unknown[]) {
    this.calls.push(['in', column, values]);
    return this;
  }
}

const applied = (filter: QueueFilter): Call[] => filter(new FakeQuery()).calls;

describe('queue predicates', () => {
  test('a facilitator application is one nobody has decided on', () => {
    assert.deepEqual(applied(facilitatorsAwaitingReview), [['eq', 'status', 'applied']]);
  });

  test('a review in the queue is one still pending', () => {
    assert.deepEqual(applied(reviewsAwaitingModeration), [['eq', 'status', 'pending']]);
  });

  test('an event proposal is submitted, not merely unpublished', () => {
    // A draft event an admin wrote themselves is not waiting on anybody, so
    // the filter keys on review_status rather than on status.
    assert.deepEqual(applied(eventsAwaitingReview), [['eq', 'review_status', 'submitted']]);
  });

  test('a stuck order is paid and not yet enrolled', () => {
    assert.deepEqual(applied(ordersNotFulfilled), [['eq', 'status', 'paid_pending_enrollment']]);
  });

  test('a refund is owed when it is positive and unsent', () => {
    // Both halves matter. Dropping the null check would re-list every refund
    // ever sent; dropping the amount check would list every cancellation,
    // including the ones that owed nothing.
    assert.deepEqual(applied(refundOwed), [
      ['gt', 'refund_centavos', 0],
      ['is', 'refunded_at', null],
    ]);
  });

  test('an overdue charge is outstanding and past its due date', () => {
    const now = new Date('2026-09-22T00:00:00.000Z');
    assert.deepEqual(applied(chargesOverdue(now)), [
      ['in', 'status', OUTSTANDING_CHARGE_STATUSES],
      ['lt', 'due_at', '2026-09-22T00:00:00.000Z'],
    ]);
  });
});

describe('OUTSTANDING_CHARGE_STATUSES', () => {
  test('lists exactly the statuses isOutstanding accepts', () => {
    // The array exists only because a query needs `.in()`. If a sixth charge
    // status is ever added and `isOutstanding` is taught about it, this fails
    // rather than the dashboard quietly under-counting overdue instalments.
    const every: ChargeStatus[] = ['scheduled', 'awaiting_payment', 'paid', 'waived', 'void', 'refunded'];
    assert.deepEqual(every.filter(isOutstanding), [...OUTSTANDING_CHARGE_STATUSES]);
  });
});

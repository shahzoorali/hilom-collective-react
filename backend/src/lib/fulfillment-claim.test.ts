/**
 * Course fulfillment must send one set of emails per order, even when two
 * PayMongo events for the same payment run fulfillOrder at the same time
 * (Canny: "Fix Duplicate Email Notifications – Course Fulfillment").
 *
 * The fake below behaves like Postgres for this one statement: UPDATEs on a row
 * run one at a time, and each re-checks its WHERE filter against the latest
 * committed value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markFulfilledOnce, type OrdersClaimClient } from './fulfillment.js';

function fakeOrders(initial: string) {
  const row = { id: 'o1', status: initial } as Record<string, unknown>;
  let lock = Promise.resolve();
  const client: OrdersClaimClient = {
    from: () => ({
      update: (patch) => ({
        eq: (_c, id) => ({
          neq: (_s, notStatus) => ({
            select: () => {
              const run = lock.then(async () => {
                await new Promise((r) => setTimeout(r, 5)); // write takes time
                if (row.id !== id || row.status === notStatus) return { data: [], error: null };
                Object.assign(row, patch);
                return { data: [{ id }], error: null };
              });
              lock = run.then(() => undefined);
              return run;
            },
          }),
        }),
      }),
    }),
  };
  return { client, row };
}

const fields = { cognito_user_sub: 'sub', moodle_user_id: 7 };

describe('markFulfilledOnce', () => {
  it('lets exactly one of two simultaneous callers win', async () => {
    const { client, row } = fakeOrders('paid_pending_enrollment');
    const results = await Promise.all([
      markFulfilledOnce(client, 'o1', fields),
      markFulfilledOnce(client, 'o1', fields),
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal(row.status, 'fulfilled');
  });

  it('lets one of five near-simultaneous retries win', async () => {
    const { client } = fakeOrders('paid_pending_enrollment');
    const results = await Promise.all(Array.from({ length: 5 }, () => markFulfilledOnce(client, 'o1', fields)));
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('returns false for an order already fulfilled (redelivery / admin retry)', async () => {
    const { client } = fakeOrders('fulfilled');
    assert.equal(await markFulfilledOnce(client, 'o1', fields), false);
  });

  it('a retry after a failed attempt (still paid_pending_enrollment) can win', async () => {
    const { client, row } = fakeOrders('paid_pending_enrollment');
    row.error_detail = 'Moodle timeout';
    assert.equal(await markFulfilledOnce(client, 'o1', fields), true);
    assert.equal(row.error_detail, null);
  });
});

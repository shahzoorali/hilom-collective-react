/**
 * Moodle course renames carry over to the product only when it is safe.
 * Canny: "Remove 'Module' on Course Title".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickProductRenames } from '../handlers/admin.js';

const prev = new Map([[16, 'Module 3: Transform Your Life'], [10, 'Module 1: Understand Yourself'], [18, 'How to Cook a Burger']]);
const next = new Map([[16, 'Transform Your Life'], [10, 'Understand Yourself'], [18, 'How to Cook a Burger']]);

describe('pickProductRenames', () => {
  it('renames a single-course product still using the old Moodle title', () => {
    const r = pickProductRenames([{ id: 'a', name: 'Module 3: Transform Your Life', courseIds: [16] }], prev, next);
    assert.deepEqual(r, [{ id: 'a', from: 'Module 3: Transform Your Life', to: 'Transform Your Life' }]);
  });
  it('leaves a product an admin renamed on purpose', () => {
    assert.deepEqual(pickProductRenames([{ id: 'a', name: 'Transform (Special)', courseIds: [16] }], prev, next), []);
  });
  it('leaves bundles alone', () => {
    assert.deepEqual(pickProductRenames([{ id: 'b', name: 'Module 1: Understand Yourself', courseIds: [10, 16] }], prev, next), []);
  });
  it('does nothing when the title did not change', () => {
    assert.deepEqual(pickProductRenames([{ id: 'c', name: 'How to Cook a Burger', courseIds: [18] }], prev, next), []);
  });
});

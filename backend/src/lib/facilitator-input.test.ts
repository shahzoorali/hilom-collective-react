/**
 * Tests for what a facilitator is allowed to put on sale.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * The package cases below are the point of this file. They are not testing
 * that a string is in a set — they are pinning the rule that a service kind
 * cannot be sellable while `POST /bookings` has no way to deliver it. If
 * someone re-enables packages, these fail, and the failure is the reminder
 * that the delivery half has to land in the same change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateService, FacilitatorInputError } from './facilitator-input.js';

const base = {
  title: 'Coaching session',
  duration_minutes: 60,
  price_centavos: 150_000,
};

describe('validateService — what can be sold', () => {
  it('accepts a single paid session', () => {
    const s = validateService({ ...base, kind: 'standard' });
    assert.equal(s.kind, 'standard');
    assert.equal(s.price_centavos, 150_000);
  });

  it('accepts a complimentary intro call, and forces it to be free', () => {
    const s = validateService({ ...base, kind: 'exploratory', price_centavos: 999_00 });
    assert.equal(s.kind, 'exploratory');
    assert.equal(s.price_centavos, 0, 'an intro call must not be chargeable');
  });

  it('defaults to a single session when no kind is given', () => {
    assert.equal(validateService({ ...base }).kind, 'standard');
  });

  it('rejects a kind the enum has never heard of', () => {
    assert.throws(
      () => validateService({ ...base, kind: 'subscription' }),
      (err: unknown) => err instanceof FacilitatorInputError && /invalid service kind/i.test((err as Error).message),
    );
  });

  /**
   * Buying a package charged the full price and produced exactly one booking:
   * the remaining sessions had no way to be scheduled. Until that is built,
   * the kind must not be sellable.
   */
  it('refuses a multi-session package, and says why rather than "invalid"', () => {
    assert.throws(
      () => validateService({ ...base, kind: 'package', sessions_count: 5 }),
      (err: unknown) =>
        err instanceof FacilitatorInputError && /packages are not available yet/i.test((err as Error).message),
    );
  });

  it('refuses a package however it is dressed up', () => {
    // A one-session "package" is harmless in principle, but allowing it would
    // mean the gate depends on a field the caller controls.
    assert.throws(() => validateService({ ...base, kind: 'package', sessions_count: 1 }), FacilitatorInputError);
    assert.throws(() => validateService({ ...base, kind: 'package' }), FacilitatorInputError);
  });
});

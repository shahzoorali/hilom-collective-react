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
   * Re-opened in 0035. What is asserted now is the two rules that keep a
   * package from being a way to give away sessions or to dress a single one up
   * as a block.
   */
  it('accepts a multi-session package', () => {
    const s = validateService({ ...base, kind: 'package', sessions_count: 6 });
    assert.equal(s.kind, 'package');
    assert.equal(s.sessions_count, 6);
    assert.equal(s.price_centavos, 150_000);
  });

  it('refuses a one-session package, which is a standard session in disguise', () => {
    // It would put the buyer through a credit flow for nothing, and the
    // database says the same (0035 checks `between 2 and 50`).
    assert.throws(() => validateService({ ...base, kind: 'package', sessions_count: 1 }), FacilitatorInputError);
  });

  it('refuses a free package', () => {
    // The free call is capped at one per client by an index on `bookings`. No
    // such cap exists, or could exist, for a block of N — so a zero-priced
    // package is an unlimited supply of free sessions.
    assert.throws(
      () => validateService({ ...base, kind: 'package', sessions_count: 4, price_centavos: 0 }),
      (err: unknown) => err instanceof FacilitatorInputError && /needs a price/i.test((err as Error).message),
    );
  });

  it('leaves sessions_count at one for every other kind', () => {
    assert.equal(validateService({ ...base, kind: 'standard', sessions_count: 9 }).sessions_count, 1);
  });
});

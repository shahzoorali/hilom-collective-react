/**
 * Tests for the date arithmetic in the payout email.
 *
 * `node:test` via tsx, no framework — same as the sibling test files.
 *
 * `formatPeriod` is the one bit of `booking-email.ts` with logic worth pinning
 * rather than markup: `facilitator_payouts.period_end` is *exclusive* (a
 * half-open [start, end) window, see migration 0013), so the last day the
 * email should name is the day before `period_end`. Off by one here and every
 * payout email tells the facilitator they were paid for a day they were not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPeriod } from './booking-email.js';

describe('formatPeriod', () => {
  it('names the last covered day, not the exclusive end', () => {
    // A full calendar month: [1 Sep 00:00, 1 Oct 00:00) covers 1–30 Sep.
    assert.equal(
      formatPeriod('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      '1–30 September 2026',
    );
  });

  it('collapses to one month name when start and end share it', () => {
    assert.equal(
      formatPeriod('2026-09-01T00:00:00Z', '2026-09-16T00:00:00Z'),
      '1–15 September 2026',
    );
  });

  it('spells out both months when the period straddles a boundary', () => {
    assert.equal(
      formatPeriod('2026-08-26T00:00:00Z', '2026-09-04T00:00:00Z'),
      '26 August 2026 – 3 September 2026',
    );
  });

  it('handles a single-day period', () => {
    assert.equal(
      formatPeriod('2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z'),
      '10–10 September 2026',
    );
  });
});

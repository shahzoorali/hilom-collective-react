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
import { formatPeriod, formatWhenFor } from './booking-email.js';

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

/**
 * The dual-zone line (0028).
 *
 * Every booking email used to render the facilitator's zone to both parties,
 * so an overseas client was always the one converting. These pin the two rules
 * that keep the fix useful: show the other zone when it says something, and
 * stay quiet when it does not.
 */
describe('formatWhenFor — the reader’s time, with the other party’s beside it', () => {
  // 15:00 in Manila, which is 18:00 in Sydney on this date.
  const at = '2026-03-12T07:00:00Z';

  it('adds the other zone when it differs', () => {
    const line = formatWhenFor(at, 'Asia/Manila', {
      timezone: 'Australia/Sydney',
      label: 'for your client',
    });
    assert.match(line, /3:00/);
    assert.match(line, /6:00/);
    assert.match(line, /for your client$/);
  });

  it('leads with whichever zone it was given, not the facilitator’s', () => {
    const clientLine = formatWhenFor(at, 'Australia/Sydney', {
      timezone: 'Asia/Manila',
      label: 'for Maya',
    });
    // The Sydney reader sees 6pm first — the bug was that they saw 3pm.
    assert.match(clientLine, /^[^—]*6:00/);
  });

  it('says one time when the two zones agree at that instant', () => {
    const line = formatWhenFor(at, 'Asia/Manila', {
      timezone: 'Asia/Singapore',
      label: 'for your client',
    });
    assert.doesNotMatch(line, /for your client/);
  });

  it('says one time when the other zone is unknown', () => {
    const line = formatWhenFor(at, 'Asia/Manila', { timezone: null, label: 'for your client' });
    assert.doesNotMatch(line, /for your client/);
  });

  it('degrades rather than throwing on an unusable zone name', () => {
    const line = formatWhenFor(at, 'Asia/Manila', { timezone: 'Not/AZone', label: 'for them' });
    assert.match(line, /3:00/);
    assert.doesNotMatch(line, /for them/);
  });

  it('tracks DST rather than assuming a fixed offset', () => {
    // Manila does not observe DST; Sydney does. The gap is +3 in January and
    // +2 in July, and a hardcoded offset would be wrong for half the year.
    const january = formatWhenFor('2026-01-12T07:00:00Z', 'Asia/Manila', {
      timezone: 'Australia/Sydney',
      label: 'x',
    });
    const july = formatWhenFor('2026-07-12T07:00:00Z', 'Asia/Manila', {
      timezone: 'Australia/Sydney',
      label: 'x',
    });
    assert.match(january, /6:00/);
    assert.match(july, /5:00/);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sumPayable,
  sumClawback,
  reconcileClaim,
  payoutCurrency,
  canVoidPayout,
  PAYOUT_CLAIM_TABLES,
  PAYOUT_PRICE_COLUMN,
  PAYOUT_CLAWBACK_COLUMN,
  type PayableRow,
} from './payout-domain.js';

/** A booking or class seat at a given price, with Hilom's default 15% split. */
const row = (id: string, price: number, currency = 'PHP'): PayableRow => ({
  id,
  price_centavos: price,
  platform_fee_centavos: Math.round(price * 0.15),
  facilitator_net_centavos: price - Math.round(price * 0.15),
  currency,
});

describe('sumPayable', () => {
  test('totals nothing to zero rather than throwing', () => {
    assert.deepEqual(sumPayable([]), { gross: 0, fees: 0, net: 0, count: 0 });
  });

  test('adds gross, fees and net independently', () => {
    const totals = sumPayable([row('a', 200000), row('b', 100000)]);
    assert.equal(totals.gross, 300000);
    assert.equal(totals.fees, 45000);
    assert.equal(totals.net, 255000);
    assert.equal(totals.count, 2);
  });

  test('net is read from the column, not recomputed from gross', () => {
    // A session booked from a package carries a share, not the list price, and
    // a facilitator-entered session carries zeros on purpose (0031). Deriving
    // net as gross-minus-fee here would pay out for both.
    const freebie: PayableRow = {
      id: 'off-platform',
      price_centavos: 0,
      platform_fee_centavos: 0,
      facilitator_net_centavos: 0,
    };
    assert.equal(sumPayable([freebie]).net, 0);
  });

  test('coerces numeric strings, which is how PostgREST can return them', () => {
    // '800' + '800' === '800800' is the bug this guards; it would surface as a
    // wildly wrong payout rather than as an error.
    const stringy = {
      id: 'x',
      price_centavos: '80000',
      platform_fee_centavos: '12000',
      facilitator_net_centavos: '68000',
    } as unknown as PayableRow;
    const totals = sumPayable([stringy, stringy]);
    assert.equal(totals.gross, 160000);
    assert.equal(totals.net, 136000);
  });

  test('totals a batch mixing bookings, class seats and event charges (0054)', () => {
    // The batch builder aliases each source's own price column
    // (price_centavos / amount_centavos) onto PayableRow.price_centavos
    // before calling this — by the time sumPayable sees them, a booking, a
    // class seat and an event ticket charge are indistinguishable, which is
    // the whole point of the shared shape.
    const booking = row('booking-1', 150000);
    const classSeat = row('class-1', 80000);
    const eventCharge: PayableRow = {
      id: 'charge-1',
      price_centavos: 500000,
      platform_fee_centavos: 100000,
      facilitator_net_centavos: 400000,
      currency: 'PHP',
    };
    const totals = sumPayable([booking, classSeat, eventCharge]);
    assert.equal(totals.count, 3);
    assert.equal(totals.gross, 150000 + 80000 + 500000);
    assert.equal(totals.net, booking.facilitator_net_centavos + classSeat.facilitator_net_centavos + 400000);
  });

  test('sumClawback totals what a set of refunded, already-paid rows takes back (0059)', () => {
    const a = row('paid-then-refunded-1', 200000);
    const b = row('paid-then-refunded-2', 50000);
    assert.equal(sumClawback([a, b]), a.facilitator_net_centavos + b.facilitator_net_centavos);
    assert.equal(sumClawback([]), 0);
  });

  test('treats null and undefined money as zero', () => {
    const partial = { id: 'x' } as unknown as PayableRow;
    assert.deepEqual(sumPayable([partial]), { gross: 0, fees: 0, net: 0, count: 1 });
  });
});

describe('reconcileClaim', () => {
  const expected = [row('a', 100000), row('b', 200000), row('c', 300000)];

  test('an uncontested batch pays for everything it read', () => {
    const result = reconcileClaim({ expected, claimed: expected, processingFeeCentavos: 0 });
    assert.equal(result.outcome, 'exact');
    assert.equal(result.outcome === 'exact' && result.totals.gross, 600000);
    assert.equal(result.outcome === 'exact' && result.totals.count, 3);
  });

  test('losing every row voids the batch rather than paying zero', () => {
    // An empty draft that looks approvable is worse than no batch: somebody
    // approves and sends it, and the work stays flagged as paid.
    const result = reconcileClaim({ expected, claimed: [], processingFeeCentavos: 0 });
    assert.equal(result.outcome, 'empty');
  });

  test('THE RACE: pays only for what it won, never for what another batch took', () => {
    // Two admins build overlapping batches. This one read three rows; by the
    // time it stamped, another batch had already claimed 'c'. If the totals
    // stayed at the pre-stamp figure, this batch pays 600000 and the other
    // pays for 'c' as well — the same session paid twice.
    const claimed = [row('a', 100000), row('b', 200000)];
    const result = reconcileClaim({ expected, claimed, processingFeeCentavos: 0 });

    assert.equal(result.outcome, 'partial');
    assert.equal(result.outcome === 'partial' && result.totals.gross, 300000);
    assert.equal(result.outcome === 'partial' && result.totals.count, 2);
    assert.equal(result.outcome === 'partial' && result.lost, 1);
  });

  test('reconciles on identity, not on count', () => {
    // Same number of rows, different rows. A count-only check would call this
    // exact and pay the original total — which happens to be right here only
    // by coincidence of arithmetic, and is wrong the moment prices differ.
    const claimed = [row('a', 100000), row('d', 900000)];
    const result = reconcileClaim({
      expected: [row('a', 100000), row('b', 200000)],
      claimed,
      processingFeeCentavos: 0,
    });
    // Counts match, so the outcome is 'exact' — and the totals are still taken
    // from `claimed`, which is what keeps it correct regardless.
    assert.equal(result.outcome, 'exact');
    assert.equal(result.outcome === 'exact' && result.totals.gross, 1000000);
  });

  test('the processing fee comes off net, not gross', () => {
    const result = reconcileClaim({
      expected,
      claimed: expected,
      processingFeeCentavos: 5000,
    });
    assert.equal(result.outcome, 'exact');
    if (result.outcome !== 'exact') return;
    assert.equal(result.totals.gross, 600000, 'gross is what clients paid and does not move');
    assert.equal(result.netAfterProcessing, result.totals.net - 5000);
  });

  test('a processing fee larger than the batch is allowed to go negative', () => {
    // Clamping to zero would hide a batch that costs more to send than it
    // contains from the person deciding whether to send it.
    const result = reconcileClaim({
      expected: [row('a', 1000)],
      claimed: [row('a', 1000)],
      processingFeeCentavos: 5000,
    });
    assert.equal(result.outcome, 'exact');
    assert.ok(result.outcome === 'exact' && result.netAfterProcessing < 0);
  });

  test('a mixed batch of bookings and class seats totals as one sum', () => {
    // 0051: a facilitator is one person owed one sum. The rows are
    // indistinguishable here by design — if they were not, this function would
    // need to know which table each came from.
    const booking = row('booking-1', 250000);
    const classSeat = row('class-seat-1', 80000);
    const result = reconcileClaim({
      expected: [booking, classSeat],
      claimed: [booking, classSeat],
      processingFeeCentavos: 0,
    });
    assert.equal(result.outcome, 'exact');
    assert.equal(result.outcome === 'exact' && result.totals.gross, 330000);
    assert.equal(result.outcome === 'exact' && result.totals.count, 2);
  });

  test('losing only the class half still pays the bookings correctly', () => {
    const booking = row('booking-1', 250000);
    const classSeat = row('class-seat-1', 80000);
    const result = reconcileClaim({
      expected: [booking, classSeat],
      claimed: [booking],
      processingFeeCentavos: 0,
    });
    assert.equal(result.outcome, 'partial');
    assert.equal(result.outcome === 'partial' && result.totals.gross, 250000);
    assert.equal(result.outcome === 'partial' && result.lost, 1);
  });
});

describe('payoutCurrency', () => {
  test('takes the first currency it finds across both sources', () => {
    assert.equal(payoutCurrency([row('a', 1000)], []), 'PHP');
  });

  test('falls through an empty first source to the second', () => {
    // A batch of nothing but class seats is an ordinary case for a facilitator
    // who only teaches groups.
    assert.equal(payoutCurrency([], [row('c', 1000, 'PHP')]), 'PHP');
  });

  test('defaults to PHP when nothing carries one', () => {
    const noCurrency = { id: 'x', price_centavos: 0, platform_fee_centavos: 0, facilitator_net_centavos: 0 };
    assert.equal(payoutCurrency([noCurrency], []), 'PHP');
  });
});

describe('voiding a payout', () => {
  test('releases every table buildPayout stamps, class seats and event charges included', () => {
    // The regression: from 0051 until this fix, voiding released only
    // `bookings`, so class seats in a voided batch were never payable again.
    // 0054 adds `registration_charges` for the same reason.
    assert.deepEqual(
      [...PAYOUT_CLAIM_TABLES].sort(),
      ['bookings', 'class_registrations', 'registration_charges'],
    );
  });

  test('the clawback column name is the same on every claim table', () => {
    // sumClawback and the void-release loop both assume one name works for
    // bookings, class seats and event charges alike (0059).
    assert.equal(PAYOUT_CLAWBACK_COLUMN, 'clawed_back_payout_id');
  });

  test('every claim table has a price column mapping, event charges aliased', () => {
    // registration_charges says amount_centavos, not price_centavos — a
    // charge is one instalment of a price (0016), and this map is what lets
    // the builder read it back into the shared PayableRow shape.
    for (const table of PAYOUT_CLAIM_TABLES) {
      assert.ok(PAYOUT_PRICE_COLUMN[table], `missing price column for ${table}`);
    }
    assert.equal(PAYOUT_PRICE_COLUMN.registration_charges, 'amount_centavos');
    assert.equal(PAYOUT_PRICE_COLUMN.bookings, 'price_centavos');
    assert.equal(PAYOUT_PRICE_COLUMN.class_registrations, 'price_centavos');
  });

  test('refuses to void a paid batch', () => {
    // Releasing already-paid work would put it in the next batch: paid twice.
    const decision = canVoidPayout('paid');
    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /already been sent/);
  });

  test('allows a draft or approved batch', () => {
    assert.deepEqual(canVoidPayout('draft'), { ok: true });
    assert.deepEqual(canVoidPayout('approved'), { ok: true });
  });

  test('allows re-voiding, which is how a half-finished void is completed', () => {
    assert.deepEqual(canVoidPayout('void'), { ok: true });
  });
});

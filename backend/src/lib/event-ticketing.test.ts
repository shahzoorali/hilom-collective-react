/**
 * Tests for the ticketed-event schedule and money rules.
 *
 * Same reasoning as booking-domain.test.ts: `node:test` via tsx, no framework,
 * and the assertions are on exact centavo amounts and exact instants rather
 * than shapes. These decide what someone is charged and when they are told
 * they are late.
 *
 * The Return to Self retreat is used as the worked example throughout, because
 * a rounding rule is much easier to argue about with real numbers in front of
 * it — and because ₱8,333.35 × 3 + ₱5,000 = ₱30,000.05 is the specific mistake
 * this module exists to make impossible.
 *
 * Run with `npm run test` in backend/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  endOfDayManila,
  manilaDate,
  splitEvenly,
  activePlans,
  buildSchedule,
  outstandingCentavos,
  paidCentavos,
  nextDueCharge,
  isFullySettled,
  validatePlan,
  validatePlans,
  validateRegistrant,
  validateRegistrantDetails,
  registrationOpen,
  depositClearedLate,
  assessRefund,
  TicketingValidationError,
  type PaymentPlan,
  type PlanInstallment,
  type Charge,
} from './event-ticketing.js';

/**
 * Indexed access that fails the assertion rather than the type-checker.
 *
 * `noUncheckedIndexedAccess` is on, and `seeds[1]!` would silence the compiler
 * at the cost of an unreadable crash if a schedule ever comes back short. This
 * reports which index was missing instead.
 */
function at<T>(items: T[], index: number): T {
  const value = items[index];
  // assert.fail returns never, which is what narrows `value` here — assert.ok
  // on a boolean expression would not.
  if (value === undefined) {
    assert.fail(`expected an item at index ${index}, got ${items.length} items`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The retreat, as configured
// ---------------------------------------------------------------------------

const EARLY_BIRD_CUTOFF = '2026-09-30T23:59:59+08:00';

const installmentPlan: PaymentPlan = {
  id: 'plan-installment',
  name: 'Early bird — 4 payments',
  kind: 'installment',
  total_centavos: 3_000_000,
  currency: 'PHP',
  available_from: null,
  available_until: EARLY_BIRD_CUTOFF,
  is_active: true,
  sort_order: 1,
};

const earlyBirdFull: PaymentPlan = {
  id: 'plan-early-full',
  name: 'Early bird — pay in full',
  kind: 'full',
  total_centavos: 3_000_000,
  currency: 'PHP',
  available_from: null,
  available_until: EARLY_BIRD_CUTOFF,
  is_active: true,
  sort_order: 0,
};

const regularFull: PaymentPlan = {
  id: 'plan-regular',
  name: 'Full payment',
  kind: 'full',
  total_centavos: 3_500_000,
  currency: 'PHP',
  available_from: '2026-10-01T00:00:00+08:00',
  available_until: null,
  is_active: true,
  sort_order: 2,
};

const retreatInstallments: PlanInstallment[] = [
  { seq: 1, label: 'Down payment', amount_centavos: 500_000, due_at: null, due_offset_days: null, is_deposit: true },
  { seq: 2, label: 'Second payment', amount_centavos: 833_333, due_at: endOfDayManila('2026-10-31'), due_offset_days: null, is_deposit: false },
  { seq: 3, label: 'Third payment', amount_centavos: 833_333, due_at: endOfDayManila('2026-11-30'), due_offset_days: null, is_deposit: false },
  { seq: 4, label: 'Final payment', amount_centavos: 833_334, due_at: endOfDayManila('2026-12-30'), due_offset_days: null, is_deposit: false },
];

/** Mid-September: inside the early-bird window, before every instalment date. */
const SEPT = new Date('2026-09-15T07:12:00Z');

// ---------------------------------------------------------------------------

describe('endOfDayManila — the due-date convention', () => {
  it('resolves a Manila calendar date to its final second, in UTC', () => {
    // 23:59:59+08 on the 31st is 15:59:59Z on the 31st.
    assert.equal(endOfDayManila('2026-10-31'), '2026-10-31T15:59:59.000Z');
    assert.equal(endOfDayManila('2026-11-30'), '2026-11-30T15:59:59.000Z');
    assert.equal(endOfDayManila('2026-12-30'), '2026-12-30T15:59:59.000Z');
  });

  it('leaves a registrant paying at 11pm Manila still on time', () => {
    const due = Date.parse(endOfDayManila('2026-10-31'));
    const paidLateEvening = Date.parse('2026-10-31T23:00:00+08:00');
    assert.ok(paidLateEvening < due, 'a 11pm Manila payment must not be overdue');
  });

  it('rejects anything that is not a plain calendar date', () => {
    assert.throws(() => endOfDayManila('31/10/2026'), TicketingValidationError);
    assert.throws(() => endOfDayManila('2026-10-31T00:00:00Z'), TicketingValidationError);
    assert.throws(() => endOfDayManila('2026-13-01'), TicketingValidationError);
  });
});

describe('manilaDate — which local day an instant falls on', () => {
  it('rolls over at Manila midnight, not UTC midnight', () => {
    // 16:30Z is 00:30 the next day in Manila.
    assert.equal(manilaDate(new Date('2026-10-31T16:30:00Z')), '2026-11-01');
    assert.equal(manilaDate(new Date('2026-10-31T15:00:00Z')), '2026-10-31');
  });
});

describe('splitEvenly — the rounding rule', () => {
  it('splits the retreat balance the way the schedule says', () => {
    assert.deepEqual(splitEvenly(2_500_000, 3), [833_333, 833_333, 833_334]);
  });

  it('never overcharges: the parts sum back exactly', () => {
    for (const total of [1, 7, 100, 2_500_000, 3_000_000, 999_999]) {
      for (const parts of [1, 2, 3, 4, 7, 12]) {
        const split = splitEvenly(total, parts);
        assert.equal(
          split.reduce((a, b) => a + b, 0),
          total,
          `${total} over ${parts} parts did not sum back`,
        );
      }
    }
  });

  it('puts the remainder last, so the customer pays it at the end', () => {
    const split = splitEvenly(100, 3);
    assert.deepEqual(split, [33, 33, 34]);
  });
});

describe('activePlans — the September cutoff enforces itself', () => {
  const all = [earlyBirdFull, installmentPlan, regularFull];

  it('offers both early-bird plans a minute before the cutoff', () => {
    const names = activePlans(all, new Date('2026-09-30T23:59:00+08:00')).map((p) => p.name);
    assert.deepEqual(names, ['Early bird — pay in full', 'Early bird — 4 payments']);
  });

  it('offers only the regular full price a minute after', () => {
    const plans = activePlans(all, new Date('2026-10-01T00:01:00+08:00'));
    assert.equal(plans.length, 1);
    assert.equal(at(plans, 0).total_centavos, 3_500_000);
    assert.equal(at(plans, 0).kind, 'full');
  });

  it('never offers an inactive plan', () => {
    const retired = [{ ...installmentPlan, is_active: false }, earlyBirdFull];
    const names = activePlans(retired, SEPT).map((p) => p.name);
    assert.deepEqual(names, ['Early bird — pay in full']);
  });
});

describe('buildSchedule — materializing the retreat plan', () => {
  const seeds = buildSchedule({
    plan: installmentPlan,
    installments: retreatInstallments,
    now: SEPT,
    holdMinutes: 60,
  });

  it('produces the four agreed amounts', () => {
    assert.deepEqual(
      seeds.map((s) => s.amount_centavos),
      [500_000, 833_333, 833_333, 833_334],
    );
  });

  it('sums to exactly ₱30,000.00 — not the ₱30,000.05 of 8,333.35 × 3', () => {
    assert.equal(seeds.reduce((a, s) => a + s.amount_centavos, 0), 3_000_000);
    assert.notEqual(500_000 + 833_335 * 3, 3_000_000); // the mistake this guards
  });

  it('dates the instalments to end of day Manila', () => {
    assert.equal(at(seeds, 1).due_at, '2026-10-31T15:59:59.000Z');
    assert.equal(at(seeds, 2).due_at, '2026-11-30T15:59:59.000Z');
    assert.equal(at(seeds, 3).due_at, '2026-12-30T15:59:59.000Z');
  });

  it('makes the deposit due at the end of the hold, not on a template date', () => {
    assert.equal(at(seeds, 0).is_deposit, true);
    assert.equal(at(seeds, 0).due_at, new Date(SEPT.getTime() + 60 * 60_000).toISOString());
  });

  it('pulls a past due date forward rather than issuing it already overdue', () => {
    const late = buildSchedule({
      plan: installmentPlan,
      installments: retreatInstallments,
      now: new Date('2026-11-15T02:00:00Z'), // October has gone
      holdMinutes: 60,
    });
    const holdEnd = new Date(Date.parse('2026-11-15T02:00:00Z') + 60 * 60_000).toISOString();
    assert.equal(at(late, 1).due_at, holdEnd, 'the October instalment is due now, not in the past');
    assert.equal(at(late, 2).due_at, '2026-11-30T15:59:59.000Z', 'November is untouched');
  });

  it('treats a pay-in-full plan as a one-row schedule', () => {
    const full = buildSchedule({
      plan: earlyBirdFull,
      installments: [
        { seq: 1, label: 'Full payment', amount_centavos: 3_000_000, due_at: null, due_offset_days: null, is_deposit: true },
      ],
      now: SEPT,
      holdMinutes: 60,
    });
    assert.equal(full.length, 1);
    assert.equal(at(full, 0).amount_centavos, 3_000_000);
    assert.equal(at(full, 0).is_deposit, true);
  });

  it('resolves a relative schedule from the registration date', () => {
    const evergreen: PaymentPlan = { ...installmentPlan, total_centavos: 200_000 };
    const seeded = buildSchedule({
      plan: evergreen,
      installments: [
        { seq: 1, label: 'Deposit', amount_centavos: 100_000, due_at: null, due_offset_days: null, is_deposit: true },
        { seq: 2, label: 'Balance', amount_centavos: 100_000, due_at: null, due_offset_days: 30, is_deposit: false },
      ],
      now: new Date('2026-09-15T07:12:00Z'),
      holdMinutes: 60,
    });
    assert.equal(at(seeded, 1).due_at, '2026-10-15T15:59:59.000Z');
  });

  it('refuses a schedule that does not sum to the plan total', () => {
    const wrong = retreatInstallments.map((i) =>
      i.seq === 4 ? { ...i, amount_centavos: 833_333 } : i,
    );
    assert.throws(
      () => buildSchedule({ plan: installmentPlan, installments: wrong, now: SEPT, holdMinutes: 60 }),
      /sum to 2999999 but the plan total is 3000000/,
    );
  });

  it('refuses a schedule without exactly one deposit', () => {
    const twoDeposits = retreatInstallments.map((i) =>
      i.seq === 2 ? { ...i, is_deposit: true } : i,
    );
    assert.throws(
      () => buildSchedule({ plan: installmentPlan, installments: twoDeposits, now: SEPT, holdMinutes: 60 }),
      /exactly one deposit/,
    );
  });
});

// ---------------------------------------------------------------------------

const charge = (seq: number, amount: number, status: Charge['status']): Charge => ({
  id: `charge-${seq}`,
  seq,
  label: `Payment ${seq}`,
  is_deposit: seq === 1,
  amount_centavos: amount,
  due_at: '2026-10-31T15:59:59.000Z',
  status,
});

describe('the ledger derivations', () => {
  const partlyPaid = [
    charge(1, 500_000, 'paid'),
    charge(2, 833_333, 'paid'),
    charge(3, 833_333, 'scheduled'),
    charge(4, 833_334, 'scheduled'),
  ];

  it('counts what is paid and what is still owed', () => {
    assert.equal(paidCentavos(partlyPaid), 1_333_333);
    assert.equal(outstandingCentavos(partlyPaid), 1_666_667);
    assert.equal(paidCentavos(partlyPaid) + outstandingCentavos(partlyPaid), 3_000_000);
  });

  it('offers the lowest unpaid instalment next, never a later one', () => {
    assert.equal(nextDueCharge(partlyPaid)?.seq, 3);
  });

  it('treats waived and void as settled but not as money received', () => {
    const settled = [
      charge(1, 500_000, 'paid'),
      charge(2, 833_333, 'waived'),
      charge(3, 833_333, 'void'),
      charge(4, 833_334, 'void'),
    ];
    assert.equal(outstandingCentavos(settled), 0);
    assert.equal(paidCentavos(settled), 500_000, 'a waiver is not income');
    assert.equal(isFullySettled(settled), true);
    assert.equal(nextDueCharge(settled), null);
  });

  it('does not call an empty ledger settled', () => {
    assert.equal(isFullySettled([]), false);
  });
});

describe('registrationOpen — the door, not the room', () => {
  const base = {
    ticketingEnabled: true,
    status: 'published',
    opensAt: null,
    closesAt: '2027-01-10T15:59:59.000Z',
  };

  it('is open inside the window', () => {
    assert.equal(registrationOpen({ ...base, now: SEPT }), true);
  });

  it('is shut after the close date', () => {
    assert.equal(registrationOpen({ ...base, now: new Date('2027-01-11T00:00:00Z') }), false);
  });

  it('is shut for a draft event, however the dates read', () => {
    assert.equal(registrationOpen({ ...base, status: 'draft', now: SEPT }), false);
  });

  it('is shut for a listing-only event', () => {
    assert.equal(registrationOpen({ ...base, ticketingEnabled: false, now: SEPT }), false);
  });
});

describe('depositClearedLate — the midnight edge', () => {
  it('flags an instalment deposit that cleared after the cutoff', () => {
    assert.equal(
      depositClearedLate({
        planKind: 'installment',
        availableUntil: EARLY_BIRD_CUTOFF,
        clearedAt: new Date('2026-10-01T00:03:00+08:00'),
      }),
      true,
    );
  });

  it('does not flag one that cleared with eight minutes to spare', () => {
    assert.equal(
      depositClearedLate({
        planKind: 'installment',
        availableUntil: EARLY_BIRD_CUTOFF,
        clearedAt: new Date('2026-09-30T23:52:00+08:00'),
      }),
      false,
    );
  });

  it('never flags a pay-in-full plan — there is no discount to protect', () => {
    assert.equal(
      depositClearedLate({
        planKind: 'full',
        availableUntil: EARLY_BIRD_CUTOFF,
        clearedAt: new Date('2026-10-01T00:03:00+08:00'),
      }),
      false,
    );
  });
});

describe('assessRefund — Participant Agreement §III refund tiers', () => {
  // Return to Self starts 22 January 2027. Deposit ₱5,000; the worked cases
  // below assume ₱13,333.33 paid (deposit + one ₱8,333.33 instalment).
  const EVENT_START = '2027-01-22T02:00:00.000Z';
  const PAID = 1_333_333;
  const DEPOSIT = 500_000;

  it('more than 60 days out: refunds payments less the deposit', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date('2026-11-01T00:00:00+08:00'), // ~82 days out
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
    });
    assert.equal(a.tier, 'gt_60_days');
    assert.equal(a.refundCentavos, PAID - DEPOSIT); // 833,333
    assert.equal(a.creditCentavos, 0);
    assert.equal(a.forfeitCentavos, DEPOSIT);
    assert.equal(a.refundCentavos + a.creditCentavos + a.forfeitCentavos, PAID);
  });

  it('more than 60 days out: also subtracts non-recoverable costs, floored at zero', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date('2026-11-01T00:00:00+08:00'),
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
      nonRecoverableCentavos: 2_000_000, // more than what is left after the deposit
    });
    assert.equal(a.refundCentavos, 0);
    assert.equal(a.forfeitCentavos, PAID);
  });

  it('31 to 60 days out: 50% as retreat credit, no cash, rest forfeited', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date('2026-12-05T00:00:00+08:00'), // ~48 days out
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
    });
    assert.equal(a.tier, '31_to_60_days');
    assert.equal(a.refundCentavos, 0);
    assert.equal(a.creditCentavos, Math.round(PAID / 2)); // 666,667 (rounds up on the odd centavo)
    assert.equal(a.forfeitCentavos, PAID - a.creditCentavos);
    assert.equal(a.creditCentavos + a.forfeitCentavos, PAID);
  });

  it('exactly 60 whole days out is still the 31–60 tier', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date(Date.parse(EVENT_START) - 60 * 86_400_000 - 3_600_000), // 60d 1h
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
    });
    assert.equal(a.daysUntilEvent, 60);
    assert.equal(a.tier, '31_to_60_days');
  });

  it('30 days or fewer out: nothing is refundable', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date('2027-01-05T00:00:00+08:00'), // ~17 days out
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
    });
    assert.equal(a.tier, '30_days_or_fewer');
    assert.equal(a.refundCentavos, 0);
    assert.equal(a.creditCentavos, 0);
    assert.equal(a.forfeitCentavos, PAID);
  });

  it('treats an event that has already started as the non-refundable tier', () => {
    const a = assessRefund({
      eventStartsAt: EVENT_START,
      now: new Date('2027-01-23T00:00:00+08:00'),
      paidCentavos: PAID,
      depositCentavos: DEPOSIT,
    });
    assert.ok(a.daysUntilEvent < 0);
    assert.equal(a.tier, '30_days_or_fewer');
  });

  it('rejects a fractional or negative centavo figure', () => {
    assert.throws(
      () =>
        assessRefund({
          eventStartsAt: EVENT_START,
          now: new Date('2026-11-01T00:00:00+08:00'),
          paidCentavos: 100.5,
          depositCentavos: DEPOSIT,
        }),
      TicketingValidationError,
    );
  });
});

describe('registrant validation', () => {
  const fields = ['dietary', 'emergency_contact'];

  it('keeps only the fields the event asked for', () => {
    const details = validateRegistrantDetails(fields, {
      dietary: '  vegetarian  ',
      emergency_contact: 'Ana, 0917 555 1234',
      medical_notes: 'should be dropped — this event does not ask',
      shoe_size: '9',
    });
    assert.deepEqual(details, { dietary: 'vegetarian', emergency_contact: 'Ana, 0917 555 1234' });
  });

  it('caps a field rather than storing an essay', () => {
    const details = validateRegistrantDetails(['dietary'], { dietary: 'x'.repeat(2_000) });
    assert.equal((details.dietary ?? '').length, 500);
  });

  it('accepts an attendee who is not the buyer', () => {
    const r = validateRegistrant({
      requestedFields: fields,
      body: { name: '  Jo Cruz ', email: 'JO@Example.COM', phone: '0917 555 1234', details: { dietary: 'none' } },
    });
    assert.equal(r.name, 'Jo Cruz');
    assert.equal(r.email, 'jo@example.com');
    assert.deepEqual(r.details, { dietary: 'none' });
  });

  it('insists on a name and a plausible email', () => {
    assert.throws(
      () => validateRegistrant({ requestedFields: [], body: { email: 'a@b.co' } }),
      /name is required/,
    );
    assert.throws(
      () => validateRegistrant({ requestedFields: [], body: { name: 'Jo', email: 'not-an-email' } }),
      /email address/,
    );
  });
});

describe('validatePlan — the admin plan builder guard rails', () => {
  const retreatPlan = () => ({
    name: 'Early bird — 4 payments',
    kind: 'installment',
    total_centavos: 3_000_000,
    available_until: '2026-09-30',
    installments: [
      { seq: 1, label: 'Down payment', amount_centavos: 500_000, is_deposit: true },
      { seq: 2, label: 'Second payment', amount_centavos: 833_333, due_date: '2026-10-31' },
      { seq: 3, label: 'Third payment', amount_centavos: 833_333, due_date: '2026-11-30' },
      { seq: 4, label: 'Final payment', amount_centavos: 833_334, due_date: '2026-12-30' },
    ],
  });

  it('accepts the retreat as configured and resolves dates to Manila end of day', () => {
    const plan = validatePlan(retreatPlan(), 0);
    assert.equal(plan.total_centavos, 3_000_000);
    assert.equal(plan.available_until, '2026-09-30T15:59:59.000Z');
    assert.deepEqual(
      plan.installments.map((i) => i.due_at),
      [null, '2026-10-31T15:59:59.000Z', '2026-11-30T15:59:59.000Z', '2026-12-30T15:59:59.000Z'],
    );
  });

  it('catches the five-centavo mistake, in pesos, before anyone is charged', () => {
    const wrong = retreatPlan();
    wrong.installments = [
      { seq: 1, label: 'Down payment', amount_centavos: 500_000, is_deposit: true },
      { seq: 2, label: 'Second payment', amount_centavos: 833_335, due_date: '2026-10-31' },
      { seq: 3, label: 'Third payment', amount_centavos: 833_335, due_date: '2026-11-30' },
      { seq: 4, label: 'Final payment', amount_centavos: 833_335, due_date: '2026-12-30' },
    ];
    assert.throws(() => validatePlan(wrong, 0), /over by ₱0\.05/);
  });

  it('names the plan and the shortfall so an admin can find it', () => {
    const short = retreatPlan();
    short.installments[3] = { seq: 4, label: 'Final payment', amount_centavos: 833_333, due_date: '2026-12-30' };
    assert.throws(() => validatePlan(short, 0), /Early bird — 4 payments.*short by ₱0\.01/s);
  });

  it('insists on exactly one deposit', () => {
    const none = retreatPlan();
    none.installments[0] = { seq: 1, label: 'Down payment', amount_centavos: 500_000, due_date: '2026-09-30' };
    assert.throws(() => validatePlan(none, 0), /needs one payment marked as the deposit/);
  });

  it('requires a non-deposit payment to say when it is due', () => {
    const undated = retreatPlan();
    undated.installments[1] = { seq: 2, label: 'Second payment', amount_centavos: 833_333 } as never;
    assert.throws(() => validatePlan(undated, 0), /needs either a due date or a number of days/);
  });

  it('refuses a payment that is both fixed-date and relative', () => {
    const both = retreatPlan();
    both.installments[1] = {
      seq: 2, label: 'Second payment', amount_centavos: 833_333,
      due_date: '2026-10-31', due_offset_days: 30,
    } as never;
    assert.throws(() => validatePlan(both, 0), /pick one/);
  });

  it('refuses a pay-in-full plan with more than one payment', () => {
    assert.throws(
      () => validatePlan({
        name: 'Full', kind: 'full', total_centavos: 200,
        installments: [
          { seq: 1, label: 'A', amount_centavos: 100, is_deposit: true },
          { seq: 2, label: 'B', amount_centavos: 100, due_date: '2026-10-31' },
        ],
      }, 0),
      /only have one payment/,
    );
  });

  it('refuses a window that closes before it opens', () => {
    const backwards = { ...retreatPlan(), available_from: '2026-10-01', available_until: '2026-09-30' };
    assert.throws(() => validatePlan(backwards, 0), /closes before it opens/);
  });

  it('refuses two plans sharing a name, since registrants pick by name', () => {
    assert.throws(() => validatePlans([retreatPlan(), retreatPlan()]), /Two plans are both called/);
  });

  it('refuses duplicate positions in one schedule', () => {
    const dupe = retreatPlan();
    dupe.installments[2] = { seq: 2, label: 'Third payment', amount_centavos: 833_333, due_date: '2026-11-30' };
    assert.throws(() => validatePlan(dupe, 0), /two payments numbered 2/);
  });
});

describe('paying in order — the rule payCharge enforces', () => {
  const schedule = (statuses: Charge['status'][]): Charge[] =>
    statuses.map((status, i) => charge(i + 1, i === 0 ? 500_000 : 833_333, status));

  it('offers the deposit first on a brand-new registration', () => {
    const s = schedule(['awaiting_payment', 'scheduled', 'scheduled', 'scheduled']);
    assert.equal(nextDueCharge(s)?.seq, 1);
  });

  it('walks forward one at a time as each clears', () => {
    assert.equal(nextDueCharge(schedule(['paid', 'scheduled', 'scheduled', 'scheduled']))?.seq, 2);
    assert.equal(nextDueCharge(schedule(['paid', 'paid', 'scheduled', 'scheduled']))?.seq, 3);
    assert.equal(nextDueCharge(schedule(['paid', 'paid', 'paid', 'scheduled']))?.seq, 4);
  });

  it('never offers a later instalment while an earlier one is unpaid', () => {
    // The specific thing payCharge refuses: someone posting charge 4's id
    // while 2 and 3 are still outstanding.
    const s = schedule(['paid', 'scheduled', 'scheduled', 'scheduled']);
    const fourth = s.find((c) => c.seq === 4)!;
    assert.notEqual(nextDueCharge(s)?.id, fourth.id, 'seq 4 must not be payable yet');
  });

  it('skips over a voided instalment rather than stalling on it', () => {
    // After an early payoff the middle rows are void, not paid — the outstanding
    // set must still resolve cleanly rather than pointing at a dead row.
    const s = schedule(['paid', 'void', 'void', 'void']);
    assert.equal(nextDueCharge(s), null);
    assert.equal(isFullySettled(s), true);
  });

  it('counts a settled-by-payoff registration as owing nothing', () => {
    const paidOff = [
      charge(1, 500_000, 'paid'),
      charge(2, 833_333, 'void'),
      charge(3, 833_333, 'void'),
      charge(4, 833_334, 'void'),
      charge(5, 2_500_000, 'paid'), // the balance payment
    ];
    assert.equal(outstandingCentavos(paidOff), 0);
    assert.equal(paidCentavos(paidOff), 3_000_000, 'the voided rows must not be double-counted');
    assert.equal(isFullySettled(paidOff), true);
  });
});

/**
 * Tests for the slot engine.
 *
 * Uses `node:test` rather than adding a runner: the backend has no test
 * framework, `tsx` is already a devDependency, and one pure module does not
 * justify pulling Vitest and its transitive tree into a Lambda repo.
 *
 * Run with `npm run test` in backend/.
 *
 * Every case here is a rule someone can get wrong in a way that costs a real
 * facilitator a real hour of their life, so the assertions are on exact
 * instants rather than counts wherever the exact answer is the point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, isBookableSlot, type ComputeSlotsInput } from './slots.js';

const MANILA = 'Asia/Manila'; // UTC+8, no DST

/** Mondays 09:00–12:00 local. */
const MON_MORNING = [{ weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 }];

function input(overrides: Partial<ComputeSlotsInput> = {}): ComputeSlotsInput {
  return {
    service: {
      durationMinutes: 60,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      maxAdvanceDays: 60,
      maxPerDay: null,
    },
    availability: MON_MORNING,
    blackouts: [],
    busy: [],
    timezone: MANILA,
    // Monday 2026-09-07 through Tuesday 2026-09-08, UTC.
    from: new Date('2026-09-06T00:00:00Z'),
    to: new Date('2026-09-09T00:00:00Z'),
    now: new Date('2026-09-01T00:00:00Z'),
    vacationUntil: null,
    ...overrides,
  };
}

describe('computeSlots — projection into the facilitator timezone', () => {
  it('places 9am Manila at 01:00 UTC, not 09:00 UTC', () => {
    const slots = computeSlots(input());
    assert.equal(slots.length, 3, 'a 3-hour window at 60 minutes should yield 3 slots');
    assert.deepEqual(
      slots.map((s) => s.startsAt),
      [
        '2026-09-07T01:00:00.000Z',
        '2026-09-07T02:00:00.000Z',
        '2026-09-07T03:00:00.000Z',
      ],
    );
  });

  it('honours a non-Manila facilitator timezone', () => {
    // Same weekly rule, read in London (BST, UTC+1, in September).
    const slots = computeSlots(input({ timezone: 'Europe/London' }));
    assert.equal(slots[0]!.startsAt, '2026-09-07T08:00:00.000Z');
  });

  it('returns nothing when the facilitator has no availability at all', () => {
    assert.deepEqual(computeSlots(input({ availability: [] })), []);
  });

  it('only generates slots on the matching weekday', () => {
    // Widen the range to a full week; still only the Monday should produce slots.
    const slots = computeSlots(
      input({ from: new Date('2026-09-06T00:00:00Z'), to: new Date('2026-09-13T00:00:00Z') }),
    );
    assert.equal(slots.length, 3);
    assert.ok(slots.every((s) => s.startsAt.startsWith('2026-09-07')));
  });
});

describe('computeSlots — duration and buffer', () => {
  it('does not emit a slot that would run past the end of the window', () => {
    // 90-minute sessions in a 180-minute window: two fit, a third would overrun.
    const slots = computeSlots(input({ service: { ...input().service, durationMinutes: 90 } }));
    assert.equal(slots.length, 2);
    assert.equal(slots.at(-1)!.endsAt, '2026-09-07T04:00:00.000Z');
  });

  it('spaces slots by duration + buffer, and reports the padded block end', () => {
    const slots = computeSlots(
      input({ service: { ...input().service, durationMinutes: 60, bufferMinutes: 15 } }),
    );
    // 9:00 and 10:15 fit; 11:30 + 60 would overrun noon.
    assert.deepEqual(
      slots.map((s) => s.startsAt),
      ['2026-09-07T01:00:00.000Z', '2026-09-07T02:15:00.000Z'],
    );
    // The session ends at 10:00 but the calendar stays blocked until 10:15.
    assert.equal(slots[0]!.endsAt, '2026-09-07T02:00:00.000Z');
    assert.equal(slots[0]!.blockEndsAt, '2026-09-07T02:15:00.000Z');
  });

  it('treats an existing booking as blocking only its own padded range', () => {
    const slots = computeSlots(
      input({
        busy: [{ startsAt: '2026-09-07T02:00:00.000Z', endsAt: '2026-09-07T03:00:00.000Z' }],
      }),
    );
    // 10am local is taken; 9am and 11am survive.
    assert.deepEqual(
      slots.map((s) => s.startsAt),
      ['2026-09-07T01:00:00.000Z', '2026-09-07T03:00:00.000Z'],
    );
  });

  it('lets back-to-back sessions sit flush without reading as a clash', () => {
    // A booking ending exactly when the 10am slot starts must not block it —
    // the ranges are half-open, matching the DB exclusion constraint.
    const slots = computeSlots(
      input({
        busy: [{ startsAt: '2026-09-07T00:00:00.000Z', endsAt: '2026-09-07T01:00:00.000Z' }],
      }),
    );
    assert.equal(slots[0]!.startsAt, '2026-09-07T01:00:00.000Z');
  });

  it('blocks a slot whose buffer would bleed into an existing booking', () => {
    // 30-minute buffer: the 9:00 session is free until 10:00 but stays blocked
    // until 10:30, which collides with a booking starting at 10:15.
    const slots = computeSlots(
      input({
        service: { ...input().service, bufferMinutes: 30 },
        busy: [{ startsAt: '2026-09-07T02:15:00.000Z', endsAt: '2026-09-07T03:15:00.000Z' }],
      }),
    );
    assert.ok(
      !slots.some((s) => s.startsAt === '2026-09-07T01:00:00.000Z'),
      'the 9am slot bleeds into the 10:15 booking and must not be offered',
    );
  });
});

describe('computeSlots — the notice and advance boundaries', () => {
  it('excludes a slot that falls exactly inside the notice period', () => {
    // now = Monday 00:30 UTC (08:30 Manila) with 12 hours' notice required:
    // every slot that morning is inside the window.
    const slots = computeSlots(
      input({
        now: new Date('2026-09-07T00:30:00Z'),
        service: { ...input().service, minNoticeMinutes: 720 },
      }),
    );
    assert.deepEqual(slots, []);
  });

  it('includes a slot exactly on the notice boundary', () => {
    // Notice of 30 minutes, now = 00:30 UTC — the 01:00 slot is precisely at
    // the boundary and must be offered, not rounded away.
    const slots = computeSlots(
      input({
        now: new Date('2026-09-07T00:30:00Z'),
        service: { ...input().service, minNoticeMinutes: 30 },
      }),
    );
    assert.equal(slots[0]!.startsAt, '2026-09-07T01:00:00.000Z');
  });

  it('excludes slots beyond the max advance window', () => {
    const slots = computeSlots(
      input({
        now: new Date('2026-09-01T00:00:00Z'),
        service: { ...input().service, maxAdvanceDays: 3 },
      }),
    );
    assert.deepEqual(slots, [], 'the Monday is 6 days out, past a 3-day horizon');
  });
});

describe('computeSlots — blackouts, vacation and daily caps', () => {
  it('removes slots overlapping a blackout but keeps the rest of the day', () => {
    const slots = computeSlots(
      input({
        blackouts: [{ startsAt: '2026-09-07T01:30:00Z', endsAt: '2026-09-07T02:30:00Z' }],
      }),
    );
    // The blackout clips 9am and 10am; 11am survives.
    assert.deepEqual(slots.map((s) => s.startsAt), ['2026-09-07T03:00:00.000Z']);
  });

  it('offers nothing while vacation mode is on', () => {
    assert.deepEqual(computeSlots(input({ vacationUntil: new Date('2026-09-30T00:00:00Z') })), []);
  });

  it('closes the day once maxPerDay bookings already exist', () => {
    const slots = computeSlots(
      input({
        service: { ...input().service, maxPerDay: 1 },
        busy: [{ startsAt: '2026-09-07T01:00:00.000Z', endsAt: '2026-09-07T02:00:00.000Z' }],
      }),
    );
    assert.deepEqual(slots, [], 'one booking already meets the cap, so the day closes');
  });

  it('does not cap how many slots are offered below the limit', () => {
    // The regression this guards: capping the *offer* would return only 2 of
    // the 3 free slots and make isBookableSlot disagree with the picker.
    const slots = computeSlots(input({ service: { ...input().service, maxPerDay: 2 } }));
    assert.equal(slots.length, 3);
  });

  it('returns an empty array for a fully booked day', () => {
    const slots = computeSlots(
      input({
        busy: [{ startsAt: '2026-09-07T01:00:00.000Z', endsAt: '2026-09-07T04:00:00.000Z' }],
      }),
    );
    assert.deepEqual(slots, []);
  });
});

describe('isBookableSlot — the server-side re-check', () => {
  const base = input();

  it('accepts a slot the picker would have offered', () => {
    const slot = isBookableSlot(new Date('2026-09-07T01:00:00.000Z'), base);
    assert.ok(slot);
    assert.equal(slot.blockEndsAt, '2026-09-07T02:00:00.000Z');
  });

  it('rejects an off-grid time inside the availability window', () => {
    // 9:30 is inside Monday morning but is not a slot boundary — a
    // hand-crafted request, not something the UI can produce.
    assert.equal(isBookableSlot(new Date('2026-09-07T01:30:00.000Z'), base), null);
  });

  it('rejects a time outside the availability window entirely', () => {
    assert.equal(isBookableSlot(new Date('2026-09-07T18:00:00.000Z'), base), null);
  });

  it('rejects an already-booked slot', () => {
    const taken = isBookableSlot(new Date('2026-09-07T01:00:00.000Z'), {
      ...base,
      busy: [{ startsAt: '2026-09-07T01:00:00.000Z', endsAt: '2026-09-07T02:00:00.000Z' }],
    });
    assert.equal(taken, null);
  });

  it('agrees with computeSlots on every slot it generates', () => {
    // The invariant that matters most: anything the picker shows must survive
    // the server-side check, or clients get "that time was just taken" on a
    // slot nobody took.
    const rules = input({ service: { ...base.service, bufferMinutes: 20, minNoticeMinutes: 60 } });
    for (const slot of computeSlots(rules)) {
      assert.ok(
        isBookableSlot(new Date(slot.startsAt), rules),
        `${slot.startsAt} was offered but rejected by isBookableSlot`,
      );
    }
  });
});

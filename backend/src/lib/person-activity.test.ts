import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from './person-activity.js';

test('builds an oldest-first timeline across registrations, payments, reminders and classes', () => {
  const items = buildActivity({
    email: 'a@b.com',
    orders: [],
    registrations: [
      {
        id: 'r1', created_at: '2026-09-25T13:15:32Z', confirmed_at: '2026-09-25T13:17:27Z',
        reminder_sent_at: '2026-10-16T06:04:42Z', events: { title: 'Retreat' }, plan_name: 'Promo',
        seat_no: 1, total_centavos: 3000000, currency: 'PHP', buyer_email: 'a@b.com', registrant_email: 'a@b.com',
      },
    ],
    charges: new Map([
      ['r1', [
        { id: 'c1', label: 'Down Payment', status: 'paid', paid_at: '2026-09-25T13:17:26Z', paid_method: 'paymongo',
          amount_centavos: 500000, currency: 'PHP', paymongo_payment_id: 'pay_1', receipt_no: 'HR-1' },
      ]],
    ]),
    reminders: new Map([['c1', [{ sent_at: '2026-10-11T16:04:43Z', tier: 'due_in_7d', sent_to: 'a@b.com' }]]]),
    ledger: new Map([['pay_1', { method: 'qrph', fee_centavos: 7500, net_centavos: 492500 }]]),
    bookings: [],
    classRegistrations: [
      { created_at: '2026-09-29T04:36:21Z', updated_at: '2026-09-29T04:59:27Z', status: 'expired', price_centavos: 11100,
        currency: 'PHP', facilitator_class_sessions: { facilitator_classes: { title: 'HIIT' } } },
    ],
    enquiries: [],
  });

  const times = items.map((i) => Date.parse(i.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const paid = items.find((i) => i.title === 'Paid Down Payment');
  assert.ok(paid);
  assert.match(paid.detail!, /QRPH/);
  assert.match(paid.detail!, /net/);
  assert.ok(items.some((i) => i.title.startsWith('Seat hold expired unpaid') && i.tone === 'bad'));
  assert.ok(items.some((i) => i.title.includes('Reminder emailed for Down Payment')));
});

test('null timestamps produce no events', () => {
  const items = buildActivity({
    email: 'a@b.com', orders: [], charges: new Map(), reminders: new Map(), ledger: new Map(),
    bookings: [], classRegistrations: [], enquiries: [],
    registrations: [{ id: 'r', created_at: '2026-01-01T00:00:00Z', confirmed_at: null, events: null,
      plan_name: 'x', seat_no: 1, total_centavos: 100, currency: 'PHP', buyer_email: 'a@b.com', registrant_email: 'a@b.com' }],
  });
  assert.equal(items.length, 1);
});

/**
 * One-off: renders every transactional email template with sample data and
 * sends it to a single test inbox, so the real SES output can be eyeballed.
 *
 * Usage:  npx tsx scripts/send-test-emails.ts [recipient]
 * Default recipient: test@bbin.in
 *
 * Uses whatever AWS credentials are in the environment. All senders here talk
 * to SES in ap-south-1 (the identity with production access).
 */
import { sendAccountCreatedEmail } from '../backend/src/lib/email.js';
import { sendEnrollmentEmail } from '../backend/src/lib/enrollment-email.js';
import {
  sendBookingConfirmed,
  sendBookingReminder,
  sendBookingCancelled,
  sendBookingRescheduled,
  sendFacilitatorApproved,
  type BookingEmailContext,
} from '../backend/src/lib/booking-email.js';
import {
  sendRegistrationConfirmed,
  sendPaymentReceipt,
  sendFullySettled,
  sendPaymentNudge,
  sendRegistrationCancelled,
  sendChargeReminder,
  sendOverdueAdminAlert,
  sendAttendeeTransferred,
  sendCancellationRequested,
  sendCancellationRequestedAdminAlert,
  sendCancellationDeclined,
  type RegistrationEmailContext,
  type EmailCharge,
} from '../backend/src/lib/registration-email.js';

const TO = process.argv[2] || 'test@bbin.in';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const agoDays = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

// --- booking fixtures ------------------------------------------------------
const bookingCtx: BookingEmailContext = {
  clientEmail: TO,
  clientName: 'Sample Client',
  facilitatorEmail: TO,
  facilitatorName: 'Sample Facilitator',
  serviceTitle: 'Intro Coaching Call',
  startsAt: inDays(3),
  facilitatorTimezone: 'Asia/Manila',
  meetingUrl: 'https://meet.example.com/hilom-sample',
  isFree: false,
};

// --- registration fixtures ----------------------------------------------------
const charges: EmailCharge[] = [
  {
    id: 'chg_1',
    seq: 1,
    label: 'Deposit',
    is_deposit: true,
    amount_centavos: 500_00,
    currency: 'PHP',
    due_at: agoDays(1),
    status: 'paid',
    receipt_no: 'HILOM-0001',
  },
  {
    id: 'chg_2',
    seq: 2,
    label: 'Instalment 2 of 3',
    is_deposit: false,
    amount_centavos: 750_00,
    currency: 'PHP',
    due_at: inDays(30),
    status: 'pending',
  },
  {
    id: 'chg_3',
    seq: 3,
    label: 'Instalment 3 of 3',
    is_deposit: false,
    amount_centavos: 750_00,
    currency: 'PHP',
    due_at: inDays(60),
    status: 'pending',
  },
];

const regCtx: RegistrationEmailContext = {
  registrationId: 'reg_sample_0001',
  buyerEmail: TO,
  registrantName: 'Sample Registrant',
  event: {
    title: 'Hilom Mountain Retreat',
    starts_at: inDays(90),
    ends_at: inDays(93),
    location: 'Sagada, Mountain Province',
    venue_details: 'Full venue details and a packing list will follow four weeks before the retreat.',
    format: 'in_person',
  },
  registration: {
    plan_name: '3-month instalment plan',
    plan_kind: 'installment',
    total_centavos: 2000_00,
    currency: 'PHP',
  },
  charges,
};

// --- run ----------------------------------------------------------------------
type Job = [name: string, run: () => Promise<void>];

const jobs: Job[] = [
  ['account-created', () => sendAccountCreatedEmail(TO, 'Sample')],
  [
    'enrollment-ready',
    () =>
      sendEnrollmentEmail({
        buyerEmail: TO,
        productName: 'How To Master Your Emotions',
        accessUrl: 'https://www.learn.hilomcollective.com',
      }),
  ],

  ['booking-confirmed', () => sendBookingConfirmed(bookingCtx)],
  ['booking-reminder', () => sendBookingReminder({ ...bookingCtx, startsAt: inDays(1) })],
  [
    'booking-cancelled',
    () =>
      sendBookingCancelled(bookingCtx, {
        cancelledBy: 'client',
        refundNote: 'A full refund of PHP 1,500.00 has been issued to your original payment method.',
      }),
  ],
  ['booking-rescheduled', () => sendBookingRescheduled({ ...bookingCtx, startsAt: inDays(7) }, inDays(3))],
  ['facilitator-approved', () => sendFacilitatorApproved(TO, 'Sample Facilitator')],

  [
    'registration-confirmed',
    () =>
      sendRegistrationConfirmed({
        ...regCtx,
        charge: charges[0],
        receiptNo: 'HILOM-0001',
      }),
  ],
  [
    'payment-receipt',
    () =>
      sendPaymentReceipt({
        ...regCtx,
        charges: [
          { ...charges[0] },
          { ...charges[1], status: 'paid', receipt_no: 'HILOM-0002' },
          { ...charges[2] },
        ],
        charge: { ...charges[1], status: 'paid', receipt_no: 'HILOM-0002' },
        receiptNo: 'HILOM-0002',
      }),
  ],
  [
    'fully-settled',
    () =>
      sendFullySettled({
        ...regCtx,
        charges: charges.map((c) => ({ ...c, status: 'paid' as const })),
      }),
  ],
  ['payment-nudge', () => sendPaymentNudge({ ...regCtx, note: 'Just checking in before the next due date.' })],
  [
    'registration-cancelled',
    () =>
      sendRegistrationCancelled({
        ...regCtx,
        refundCentavos: 300_00,
        creditCentavos: 200_00,
        reason: 'Cancelled at your request, 45 days before the retreat.',
      }),
  ],
  ...(['due_in_7d', 'due_today', 'overdue_3d', 'overdue_7d'] as const).map(
    (tier): Job => [
      `charge-reminder-${tier}`,
      () =>
        sendChargeReminder({
          tier,
          to: TO,
          registrantName: 'Sample Registrant',
          eventTitle: 'Hilom Mountain Retreat',
          label: 'Instalment 2 of 3',
          amountCentavos: 750_00,
          currency: 'PHP',
          dueAt: tier.startsWith('overdue') ? agoDays(4) : inDays(tier === 'due_today' ? 0 : 7),
          registrationId: 'reg_sample_0001',
        }),
    ],
  ),
  [
    'overdue-admin-alert',
    () =>
      sendOverdueAdminAlert({
        to: TO,
        registrationId: 'reg_sample_0001',
        label: 'Instalment 2 of 3',
        amountCentavos: 750_00,
        currency: 'PHP',
        dueAt: agoDays(4),
      }),
  ],
  [
    'attendee-transferred',
    () =>
      sendAttendeeTransferred({
        eventTitle: 'Hilom Mountain Retreat',
        oldName: 'Old Attendee',
        oldEmail: TO,
        newName: 'New Attendee',
        newEmail: TO,
      }),
  ],
  [
    'cancellation-requested',
    () =>
      sendCancellationRequested({
        to: TO,
        registrantName: 'Sample Registrant',
        eventTitle: 'Hilom Mountain Retreat',
      }),
  ],
  [
    'cancellation-requested-admin-alert',
    () =>
      sendCancellationRequestedAdminAlert({
        to: TO,
        registrationId: 'reg_sample_0001',
        registrantName: 'Sample Registrant',
        eventTitle: 'Hilom Mountain Retreat',
        reason: 'A schedule conflict came up.',
      }),
  ],
  [
    'cancellation-declined',
    () =>
      sendCancellationDeclined({
        to: TO,
        registrantName: 'Sample Registrant',
        eventTitle: 'Hilom Mountain Retreat',
        reason: 'This is inside the 30-day window, so the place is non-refundable per the agreement.',
      }),
  ],
];

console.log(`Sending ${jobs.length} template(s) to ${TO}\n`);
for (const [name, run] of jobs) {
  try {
    await run();
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log('\nDone. Note: booking-* and attendee-transferred send two messages each (client + facilitator).');

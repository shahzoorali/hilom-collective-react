/**
 * Transactional email for event registrations.
 *
 * Composed from the branded shell in email-layout.ts, same as booking-email.ts,
 * and sending is best-effort for the same reason: a receipt that failed to send
 * must never roll back a payment that succeeded. Failures are logged and
 * swallowed.
 *
 * The recurring content problem here is that a registrant on an instalment plan
 * has to be told three things at once — what they just paid, what is left, and
 * when it is due — and told them in a message they will come back to in six
 * weeks. So every email in this file carries the **whole remaining schedule**
 * rather than only the next line. It costs nothing and it is the difference
 * between an email that answers "how much do I still owe?" and one that
 * prompts a support message asking it.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  renderEmail,
  renderText,
  p,
  note,
  details,
  button,
  escapeHtml,
} from './email-layout.js';
import { isOutstanding, type ChargeStatus } from './event-ticketing.js';

// ap-south-1 is where the verified SES identity with production access lives;
// the rest of the stack is ap-southeast-1. Same as every other sender here.
const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <hello@hilomcollective.com>';
const SITE = 'https://www.hilomcollective.com';

const registrationUrl = (registrationId: string) => `${SITE}/account/registrations/${registrationId}`;

export interface EmailCharge {
  id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: ChargeStatus;
  receipt_no?: string | null;
}

export interface EmailEvent {
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  venue_details: string | null;
  format: string | null;
}

export interface EmailRegistration {
  plan_name: string;
  plan_kind: 'full' | 'installment';
  total_centavos: number;
  currency: string;
}

export interface RegistrationEmailContext {
  registrationId: string;
  buyerEmail: string;
  registrantName: string;
  event: EmailEvent;
  registration: EmailRegistration;
  charges: EmailCharge[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const peso = (centavos: number, currency = 'PHP'): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 2 }).format(
    centavos / 100,
  );

/**
 * A due date, as the Manila calendar day it means.
 *
 * Due dates are stored as the last second of a Manila day. Rendering that in
 * any other zone shows the wrong date to half the audience, and rendering the
 * time alongside it ("11:59 PM") reads as a deadline in minutes rather than a
 * day someone has. So: the day, named, and nothing else.
 */
const dueDay = (iso: string): string =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));

/** The event's dates, collapsed to a range when it spans days. */
function whenEvent(event: EmailEvent): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(iso));

  if (!event.ends_at) return fmt(event.starts_at);
  const start = fmt(event.starts_at);
  const end = fmt(event.ends_at);
  return start === end ? start : `${start} — ${end}`;
}

/**
 * The remaining schedule as a table.
 *
 * Paid rows are kept rather than filtered out. Someone reading their third
 * reminder wants to see that two payments landed, not just the one that has
 * not — and a schedule that shrinks each time is harder to reconcile against a
 * bank statement than one that stays put and gains ticks.
 */
function scheduleBlock(charges: EmailCharge[], currency: string): string {
  if (charges.length <= 1) return '';

  const rows = charges
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({
      label: c.is_deposit ? c.label : `${c.label} — due ${dueDay(c.due_at)}`,
      value: `${escapeHtml(peso(c.amount_centavos, currency))}${statusMark(c.status)}`,
    }));

  return details(rows);
}

function statusMark(status: ChargeStatus): string {
  if (status === 'paid') return ' &nbsp;<span style="color:#2f5e3e;">paid</span>';
  if (status === 'waived') return ' &nbsp;<span style="color:#6b6b6b;">waived</span>';
  if (status === 'void') return ' &nbsp;<span style="color:#6b6b6b;">no longer due</span>';
  return '';
}

const outstandingTotal = (charges: EmailCharge[]): number =>
  charges.filter((c) => isOutstanding(c.status)).reduce((acc, c) => acc + c.amount_centavos, 0);

const nextDue = (charges: EmailCharge[]): EmailCharge | undefined =>
  charges
    .filter((c) => isOutstanding(c.status))
    .sort((a, b) => a.seq - b.seq)[0];

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  try {
    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject },
            Body: { Text: { Data: text }, Html: { Data: html } },
          },
        },
      }),
    );
  } catch (err) {
    console.warn('[registration-email] send failed — the payment itself is unaffected', {
      to,
      subject,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Sent once, when the deposit clears and the seat becomes theirs.
 *
 * Carries the deposit receipt *and* the full schedule, because this is the
 * message people keep. It also states plainly that a missed payment does not
 * automatically cancel a place — that is the actual policy, and someone who
 * believes otherwise will panic quietly instead of getting in touch.
 */
export async function sendRegistrationConfirmed(
  ctx: RegistrationEmailContext & { charge: EmailCharge; receiptNo: string },
): Promise<void> {
  const { event, registration, charges, charge, receiptNo } = ctx;
  const currency = registration.currency;
  const owing = outstandingTotal(charges);
  const next = nextDue(charges);

  const heading = `You're going to ${event.title}`;

  const rows = [
    { label: 'Event', value: escapeHtml(event.title) },
    { label: 'When', value: escapeHtml(whenEvent(event)) },
    ...(event.location ? [{ label: 'Where', value: escapeHtml(event.location) }] : []),
    { label: 'Plan', value: escapeHtml(registration.plan_name) },
    { label: 'Paid now', value: escapeHtml(peso(charge.amount_centavos, currency)) },
    { label: 'Receipt', value: escapeHtml(receiptNo) },
  ];

  let body =
    p(`Your place is confirmed, ${escapeHtml(ctx.registrantName)}. We have you down for ${escapeHtml(event.title)}.`) +
    details(rows);

  if (event.venue_details) body += p(escapeHtml(event.venue_details));

  if (owing > 0) {
    body +=
      p(`<strong>What's left to pay: ${escapeHtml(peso(owing, currency))}</strong>`) +
      scheduleBlock(charges, currency) +
      (next
        ? p(
            `Your next payment of ${escapeHtml(peso(next.amount_centavos, currency))} is due ` +
              `${escapeHtml(dueDay(next.due_at))}.`,
          )
        : '') +
      button('Pay the next instalment', registrationUrl(ctx.registrationId)) +
      note(
        'You can pay each instalment from your account whenever suits you, or settle the balance early. ' +
          'If a payment is ever late your place is not cancelled automatically — we will get in touch.',
      );
  } else {
    body +=
      p('That is everything paid — nothing further is due.') +
      button('View your registration', registrationUrl(ctx.registrationId));
  }

  const textLines = [
    `Your place at ${event.title} is confirmed.`,
    `When: ${whenEvent(event)}`,
    ...(event.location ? [`Where: ${event.location}`] : []),
    `Paid now: ${peso(charge.amount_centavos, currency)} (receipt ${receiptNo})`,
    ...(owing > 0
      ? [
          `Still to pay: ${peso(owing, currency)}`,
          ...charges
            .filter((c) => isOutstanding(c.status))
            .map((c) => `  ${c.label} — ${peso(c.amount_centavos, currency)} due ${dueDay(c.due_at)}`),
          '',
          'A late payment does not cancel your place automatically — we will get in touch.',
        ]
      : ['Nothing further is due.']),
    '',
    registrationUrl(ctx.registrationId),
  ];

  await send(
    ctx.buyerEmail,
    `You're going to ${event.title}`,
    renderText(heading, textLines),
    renderEmail({ preheader: `Your place at ${event.title} is confirmed.`, heading, body }),
  );
}

/** Sent for every cleared instalment after the deposit. */
export async function sendPaymentReceipt(
  ctx: RegistrationEmailContext & { charge: EmailCharge; receiptNo: string },
): Promise<void> {
  const { event, registration, charges, charge, receiptNo } = ctx;
  const currency = registration.currency;
  const owing = outstandingTotal(charges);
  const next = nextDue(charges);

  const heading = `Payment received — ${peso(charge.amount_centavos, currency)}`;

  let body =
    p(`Thank you, ${escapeHtml(ctx.registrantName)}. We have received your ${escapeHtml(charge.label.toLowerCase())} for ${escapeHtml(event.title)}.`) +
    details([
      { label: 'Amount', value: escapeHtml(peso(charge.amount_centavos, currency)) },
      { label: 'Receipt', value: escapeHtml(receiptNo) },
      { label: 'Event', value: escapeHtml(event.title) },
    ]);

  if (owing > 0) {
    body +=
      p(`<strong>Remaining balance: ${escapeHtml(peso(owing, currency))}</strong>`) +
      scheduleBlock(charges, currency) +
      (next ? p(`Next due ${escapeHtml(dueDay(next.due_at))}.`) : '') +
      button('View or pay', registrationUrl(ctx.registrationId));
  } else {
    body += p('That settles your balance in full — thank you.');
  }

  await send(
    ctx.buyerEmail,
    `Payment received for ${event.title}`,
    renderText(heading, [
      `We received ${peso(charge.amount_centavos, currency)} for ${event.title}.`,
      `Receipt: ${receiptNo}`,
      owing > 0 ? `Remaining balance: ${peso(owing, currency)}` : 'Your balance is settled in full.',
      ...(next ? [`Next due ${dueDay(next.due_at)}.`] : []),
      '',
      registrationUrl(ctx.registrationId),
    ]),
    renderEmail({ preheader: `Receipt ${receiptNo}`, heading, body }),
  );
}

/** Sent once an instalment plan is fully settled. */
export async function sendFullySettled(ctx: RegistrationEmailContext): Promise<void> {
  const { event, registration } = ctx;
  const heading = "You're all paid up";

  const body =
    p(`That is ${escapeHtml(event.title)} paid in full, ${escapeHtml(ctx.registrantName)}. Nothing further is due.`) +
    details([
      { label: 'Event', value: escapeHtml(event.title) },
      { label: 'When', value: escapeHtml(whenEvent(event)) },
      ...(event.location ? [{ label: 'Where', value: escapeHtml(event.location) }] : []),
      { label: 'Total paid', value: escapeHtml(peso(registration.total_centavos, registration.currency)) },
    ]) +
    p('We will be in touch closer to the date with everything you need to know before you travel.') +
    button('View your registration', registrationUrl(ctx.registrationId));

  await send(
    ctx.buyerEmail,
    `You're all paid up for ${event.title}`,
    renderText(heading, [
      `${event.title} is paid in full. Nothing further is due.`,
      `When: ${whenEvent(event)}`,
      '',
      registrationUrl(ctx.registrationId),
    ]),
    renderEmail({ preheader: `${event.title} is paid in full.`, heading, body }),
  );
}

/**
 * A nudge toward an outstanding payment, sent by an admin.
 *
 * Deliberately does not carry a PayMongo link. A hosted session expires, and a
 * dead checkout link in an email is worse than no link — it reads as "the
 * system is broken" rather than "click through and pay". This points at the
 * registration page, where the buyer mints a fresh session at the moment they
 * actually want to pay.
 */
export async function sendPaymentNudge(
  ctx: RegistrationEmailContext & { note?: string | null },
): Promise<void> {
  const { event, registration, charges } = ctx;
  const currency = registration.currency;
  const owing = outstandingTotal(charges);
  const next = nextDue(charges);

  const heading = `A payment for ${event.title}`;

  const body =
    p(`Hello ${escapeHtml(ctx.registrantName)},`) +
    p(
      next
        ? `This is a reminder about your ${escapeHtml(next.label.toLowerCase())} of ` +
          `${escapeHtml(peso(next.amount_centavos, currency))} for ${escapeHtml(event.title)}, due ` +
          `${escapeHtml(dueDay(next.due_at))}.`
        : `This is a reminder about the ${escapeHtml(peso(owing, currency))} outstanding on your place at ` +
          `${escapeHtml(event.title)}.`,
    ) +
    (ctx.note ? p(escapeHtml(ctx.note)) : '') +
    scheduleBlock(charges, currency) +
    button('Pay now', registrationUrl(ctx.registrationId)) +
    note('Your place is not at risk — if anything about the timing is difficult, just reply to this email.');

  await send(
    ctx.buyerEmail,
    `A payment for ${event.title}`,
    renderText(heading, [
      next
        ? `Your ${next.label.toLowerCase()} of ${peso(next.amount_centavos, currency)} is due ${dueDay(next.due_at)}.`
        : `${peso(owing, currency)} is outstanding on your place at ${event.title}.`,
      ...(ctx.note ? ['', ctx.note] : []),
      '',
      registrationUrl(ctx.registrationId),
      '',
      'Your place is not at risk — reply to this email if the timing is difficult.',
    ]),
    renderEmail({ preheader: `${peso(owing, currency)} outstanding`, heading, body }),
  );
}

/**
 * Confirms that a place has been cancelled.
 *
 * States the refund position explicitly, including when it is nothing, because
 * the alternative is someone waiting for money that was never coming. Refunds
 * are recorded here and moved by a human, so the wording promises a person
 * rather than a timeline the system cannot keep.
 */
export async function sendRegistrationCancelled(
  ctx: RegistrationEmailContext & { refundCentavos: number | null; reason?: string | null },
): Promise<void> {
  const { event, registration, charges, refundCentavos } = ctx;
  const currency = registration.currency;
  const paid = charges
    .filter((c) => c.status === 'paid')
    .reduce((acc, c) => acc + c.amount_centavos, 0);

  const heading = `Your place at ${event.title} has been cancelled`;

  const body =
    p(`Hello ${escapeHtml(ctx.registrantName)},`) +
    p(`Your place at ${escapeHtml(event.title)} has been cancelled and is no longer held.`) +
    (ctx.reason ? p(escapeHtml(ctx.reason)) : '') +
    details([
      { label: 'Event', value: escapeHtml(event.title) },
      { label: 'Total paid', value: escapeHtml(peso(paid, currency)) },
      {
        label: 'Refund',
        value:
          refundCentavos && refundCentavos > 0
            ? escapeHtml(peso(refundCentavos, currency))
            : 'None',
      },
    ]) +
    (refundCentavos && refundCentavos > 0
      ? p('Someone will be in touch to arrange the transfer.')
      : '') +
    note('If any of this looks wrong, reply to this email and a person will pick it up.');

  await send(
    ctx.buyerEmail,
    `Your place at ${event.title} has been cancelled`,
    renderText(heading, [
      `Your place at ${event.title} has been cancelled.`,
      ...(ctx.reason ? ['', ctx.reason] : []),
      '',
      `Total paid: ${peso(paid, currency)}`,
      `Refund: ${refundCentavos && refundCentavos > 0 ? peso(refundCentavos, currency) : 'None'}`,
      ...(refundCentavos && refundCentavos > 0 ? ['', 'Someone will be in touch to arrange the transfer.'] : []),
    ]),
    renderEmail({ preheader: `Your place at ${event.title} has been cancelled.`, heading, body }),
  );
}

// ---------------------------------------------------------------------------
// Sweep-triggered
// ---------------------------------------------------------------------------

type ReminderTier = 'due_in_7d' | 'due_today' | 'overdue_3d' | 'overdue_7d';

const TIER_COPY: Record<ReminderTier, { subject: (label: string) => string; lead: string }> = {
  due_in_7d: {
    subject: (label) => `Coming up: ${label}`,
    lead: 'Just a heads up — this is coming up in a week.',
  },
  due_today: {
    subject: (label) => `Due today: ${label}`,
    lead: 'This is due today.',
  },
  overdue_3d: {
    subject: (label) => `We missed a payment — ${label}`,
    lead: "We haven't received this yet. Your place is still held — there's no rush, just a nudge.",
  },
  overdue_7d: {
    subject: (label) => `Please get in touch — ${label}`,
    lead:
      "This has been outstanding a week now. Your place is still held and nothing is at risk — " +
      'if anything about the timing is difficult, just reply to this email and we will sort it out.',
  },
};

/**
 * One of the four instalment reminder emails.
 *
 * A single template rather than four, differing only in heading and lead
 * line — the four tiers are one message getting gradually more direct, not
 * four different messages, and writing them as one template is what keeps
 * that consistent.
 */
export async function sendChargeReminder(input: {
  tier: ReminderTier;
  to: string;
  registrantName: string;
  eventTitle: string;
  label: string;
  amountCentavos: number;
  currency: string;
  dueAt: string;
  registrationId: string;
}): Promise<void> {
  const { tier, to, registrantName, eventTitle, label, amountCentavos, currency, dueAt, registrationId } = input;
  const copy = TIER_COPY[tier];
  const heading = copy.subject(`${peso(amountCentavos, currency)} for ${eventTitle}`);

  const body =
    p(`Hello ${escapeHtml(registrantName)},`) +
    p(escapeHtml(copy.lead)) +
    details([
      { label: 'Event', value: escapeHtml(eventTitle) },
      { label: 'Payment', value: escapeHtml(label) },
      { label: 'Amount', value: escapeHtml(peso(amountCentavos, currency)) },
      { label: 'Due', value: escapeHtml(dueDay(dueAt)) },
    ]) +
    button('Pay now', registrationUrl(registrationId));

  await send(
    to,
    copy.subject(`${peso(amountCentavos, currency)} for ${eventTitle}`),
    renderText(heading, [
      copy.lead,
      '',
      `${label}: ${peso(amountCentavos, currency)}, due ${dueDay(dueAt)}`,
      '',
      registrationUrl(registrationId),
    ]),
    renderEmail({ preheader: copy.lead, heading, body }),
  );
}

/**
 * Tells an admin a charge just crossed into overdue.
 *
 * One per flagged charge rather than a daily digest: for thirteen people a
 * digest would arrive as a wall of names by December, and a single-line email
 * the moment it happens is the one that actually gets read and acted on.
 */
export async function sendOverdueAdminAlert(input: {
  to: string;
  registrationId: string;
  label: string;
  amountCentavos: number;
  currency: string;
  dueAt: string;
}): Promise<void> {
  const { to, registrationId, label, amountCentavos, currency, dueAt } = input;
  const heading = `Overdue: ${peso(amountCentavos, currency)}`;

  const body =
    p(`${escapeHtml(label)} — ${escapeHtml(peso(amountCentavos, currency))} — went overdue on ${escapeHtml(dueDay(dueAt))}.`) +
    p('The seat is still held. This is a flag for review, not an automatic cancellation.') +
    button('Open in admin', `${SITE}/admin/registrations`);

  await send(
    to,
    `Overdue: ${peso(amountCentavos, currency)} — ${label}`,
    renderText(heading, [
      `${label} (${peso(amountCentavos, currency)}) went overdue on ${dueDay(dueAt)}.`,
      'The seat is still held. This is a flag for review, not an automatic cancellation.',
      '',
      `${SITE}/admin/registrations`,
    ]),
    renderEmail({ heading, body }),
  );
}

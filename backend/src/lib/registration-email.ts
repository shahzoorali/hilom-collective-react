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
import { renderInvite } from './ical.js';
import { buildRawEmail, type RawEmailAttachment } from './mime.js';

// ap-south-1 is where the verified SES identity with production access lives;
// the rest of the stack is ap-southeast-1. Same as every other sender here.
const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <kumusta@hilomcollective.com>';
/** The same identity as SENDER, bare, for the invite's ORGANIZER line. */
const SENDER_EMAIL = 'kumusta@hilomcollective.com';
const SENDER_NAME = 'Hilom Collective';
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
  /**
   * Joining link for a virtual event, and any wording that goes with it.
   *
   * Optional on the interface rather than required because most callers of
   * these templates (reminders, cancellations) have no business loading it —
   * making it required would push a secret into every query that mentions an
   * event. Only the sends that are supposed to release it fetch it.
   */
  join_url?: string | null;
  join_instructions?: string | null;
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

/**
 * The joining details, as a block, or nothing.
 *
 * `button()` rather than a bare link so it survives the client that strips
 * underlines, and the URL is repeated as text underneath because a Zoom link
 * is the one thing people copy into a calendar entry by hand.
 *
 * The link is escaped like any other value. It is admin- or facilitator-typed,
 * so it is not hostile input, but it lands in an href and there is no version
 * of "trusted enough to skip escaping" worth defending here.
 */
function joinBlock(event: EmailEvent): string {
  if (!event.join_url) return '';
  return (
    p('<strong>How to join</strong>') +
    button('Join the session', event.join_url) +
    p(`<a href="${escapeHtml(event.join_url)}">${escapeHtml(event.join_url)}</a>`) +
    (event.join_instructions ? note(escapeHtml(event.join_instructions)) : '')
  );
}

/** The same, for the plain-text part. */
function joinLines(event: EmailEvent): string[] {
  if (!event.join_url) return [];
  return [
    '',
    'How to join:',
    event.join_url,
    ...(event.join_instructions ? [event.join_instructions] : []),
  ];
}

/**
 * A calendar invite for one registration, as an attachable .ics.
 *
 * Bookings have carried one since 0012; ticketed events never did, so someone
 * who paid for a retreat got a confirmation they had to transcribe into their
 * own calendar by hand. Same renderInvite() the booking emails use, so the two
 * behave identically in Gmail and Outlook rather than one of them being subtly
 * different.
 *
 * `METHOD:REQUEST` is what makes a client draw an invite card instead of
 * showing a file to download. It travels as an ordinary attachment part rather
 * than through email-mime.ts's dedicated invite sender, because this email may
 * *also* carry the participant agreement PDF and that sender takes exactly one
 * calendar part and nothing else. The Content-Type still says
 * `method=REQUEST`, which is what the clients actually read.
 *
 * ORGANIZER is Hilom rather than the facilitator: an event is run by the
 * collective, the roster is ours, and replies belong in an inbox somebody
 * reads. That differs from a 1:1 booking deliberately.
 */
export function registrationInvite(input: {
  registrationId: string;
  event: EmailEvent;
  attendeeEmail: string;
  attendeeName: string;
  /**
   * Must increase for the same UID or a calendar will ignore the update. The
   * confirmation sends 0; anything re-issuing the invite later passes seconds
   * since the epoch, which is monotonic and needs no column to track.
   */
  sequence: number;
}): RawEmailAttachment | null {
  const { event } = input;
  if (!event.starts_at) return null;

  // Every published event has an end time today, and the column is nullable,
  // so a missing one gets an hour rather than a zero-length entry that some
  // clients drop silently.
  const endsAt = event.ends_at ?? new Date(Date.parse(event.starts_at) + 3_600_000).toISOString();

  // What someone opening the calendar entry a month later needs: where to
  // join, and where to find everything else.
  const description = [
    event.join_url ? `Join: ${event.join_url}` : null,
    event.join_instructions ?? null,
    event.venue_details ?? null,
    `Your registration: ${registrationUrl(input.registrationId)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const ics = renderInvite({
    method: 'REQUEST',
    // Per registration, not per event: two people at the same retreat hold two
    // separate calendar entries, and one person's decline must not touch the
    // other's.
    uid: `event-registration-${input.registrationId}@hilomcollective.com`,
    sequence: input.sequence,
    startsAt: event.starts_at,
    endsAt,
    summary: event.title,
    description,
    location: event.join_url || event.location || null,
    organizer: { email: SENDER_EMAIL, name: SENDER_NAME },
    attendee: { email: input.attendeeEmail, name: input.attendeeName },
  });

  return {
    filename: 'invite.ics',
    // `method=REQUEST` on the Content-Type, not only inside the body, is what
    // Gmail and Outlook key off to render invite controls. See email-mime.ts,
    // which makes the same point about the dedicated invite sender.
    contentType: 'text/calendar; charset="UTF-8"; method=REQUEST',
    content: new TextEncoder().encode(ics),
  };
}

async function send(
  to: string,
  subject: string,
  text: string,
  html: string,
  attachments?: RawEmailAttachment[],
): Promise<void> {
  try {
    // Content.Simple has no attachment support, so an email that carries one
    // is composed as raw MIME instead. Everything else stays on the simple
    // path — it is less to get wrong.
    const content =
      attachments && attachments.length > 0
        ? {
            Raw: {
              Data: buildRawEmail({ from: SENDER, to, subject, text, html, attachments }),
            },
          }
        : {
            Simple: {
              Subject: { Data: subject },
              Body: { Text: { Data: text }, Html: { Data: html } },
            },
          };

    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [to] },
        Content: content,
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
 *
 * For events that have one, the participant agreement PDF is attached here and
 * only here — the confirmation is the copy someone keeps and refers back to,
 * and re-attaching 2 MB to every instalment receipt would earn nothing.
 */
export async function sendRegistrationConfirmed(
  ctx: RegistrationEmailContext & {
    charge: EmailCharge;
    receiptNo: string;
    agreement?: { filename: string; pdf: Uint8Array } | null;
  },
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
  body += joinBlock(event);

  if (ctx.agreement) {
    body += note(
      'Your Participant Agreement is attached to this email — the same terms you agreed to when you ' +
        'registered. Please keep it for your records; there is nothing to send back.',
    );
  }

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
    ...joinLines(event),
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
    ...(ctx.agreement
      ? ['', 'Your Participant Agreement is attached — please keep it. Nothing to send back.']
      : []),
    '',
    registrationUrl(ctx.registrationId),
  ];

  // The calendar invite rides along with the confirmation rather than as a
  // second email: this is the message people keep, and the entry belongs in the
  // same place as the receipt. Sequence 0 — this is the first issue of it.
  const invite = registrationInvite({
    registrationId: ctx.registrationId,
    event,
    attendeeEmail: ctx.buyerEmail,
    attendeeName: ctx.registrantName,
    sequence: 0,
  });

  const attachments: RawEmailAttachment[] = [
    ...(ctx.agreement
      ? [
          {
            filename: ctx.agreement.filename,
            contentType: 'application/pdf',
            content: ctx.agreement.pdf,
          },
        ]
      : []),
    ...(invite ? [invite] : []),
  ];

  await send(
    ctx.buyerEmail,
    `You're going to ${event.title}`,
    renderText(heading, textLines),
    renderEmail({ preheader: `Your place at ${event.title} is confirmed.`, heading, body }),
    attachments.length > 0 ? attachments : undefined,
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
  ctx: RegistrationEmailContext & {
    refundCentavos: number | null;
    /** A credit toward a future retreat (Agreement §III, 31–60 day tier). */
    creditCentavos?: number | null;
    reason?: string | null;
  },
): Promise<void> {
  const { event, registration, charges, refundCentavos } = ctx;
  const currency = registration.currency;
  const credit = ctx.creditCentavos ?? 0;
  const paid = charges
    .filter((c) => c.status === 'paid')
    .reduce((acc, c) => acc + c.amount_centavos, 0);

  const heading = `Your place at ${event.title} has been cancelled`;

  const rows = [
    { label: 'Event', value: escapeHtml(event.title) },
    { label: 'Total paid', value: escapeHtml(peso(paid, currency)) },
    {
      label: 'Refund',
      value:
        refundCentavos && refundCentavos > 0 ? escapeHtml(peso(refundCentavos, currency)) : 'None',
    },
  ];
  if (credit > 0) {
    rows.push({
      label: 'Retreat credit',
      value: `${escapeHtml(peso(credit, currency))} — toward a future Hilom retreat, valid 12 months`,
    });
  }

  const followUp =
    credit > 0
      ? p('Someone will be in touch to confirm your credit and how to use it.')
      : refundCentavos && refundCentavos > 0
        ? p('Someone will be in touch to arrange the transfer.')
        : '';

  const body =
    p(`Hello ${escapeHtml(ctx.registrantName)},`) +
    p(`Your place at ${escapeHtml(event.title)} has been cancelled and is no longer held.`) +
    (ctx.reason ? p(escapeHtml(ctx.reason)) : '') +
    details(rows) +
    followUp +
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
      ...(credit > 0
        ? [`Retreat credit: ${peso(credit, currency)} (toward a future Hilom retreat, valid 12 months)`]
        : []),
      ...(credit > 0
        ? ['', 'Someone will be in touch to confirm your credit and how to use it.']
        : refundCentavos && refundCentavos > 0
          ? ['', 'Someone will be in touch to arrange the transfer.']
          : []),
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

// ---------------------------------------------------------------------------
// Self-service: transfer and cancellation requests
// ---------------------------------------------------------------------------

/**
 * Tells both the outgoing and incoming attendee that a place changed hands.
 *
 * Sent to both addresses, deliberately: the person stepping back should know
 * their name is off the roster, and the person stepping in should know the
 * change was intentional rather than a stranger's confirmation email landing
 * in their inbox by mistake.
 */
export async function sendAttendeeTransferred(input: {
  eventTitle: string;
  oldName: string;
  oldEmail: string;
  newName: string;
  newEmail: string;
}): Promise<void> {
  const { eventTitle, oldName, oldEmail, newName, newEmail } = input;
  const heading = `A place at ${eventTitle} changed hands`;

  const bodyFor = (recipient: 'old' | 'new') =>
    p(
      recipient === 'old'
        ? `${escapeHtml(newName)} is now attending ${escapeHtml(eventTitle)} in your place. If this wasn't you, reply to this email right away.`
        : `You're now down to attend ${escapeHtml(eventTitle)}, taking over from ${escapeHtml(oldName)}. If this wasn't expected, reply to this email.`,
    );

  await send(
    oldEmail,
    heading,
    renderText(heading, [`${newName} is now attending ${eventTitle} in your place.`, 'If this was not you, reply to this email.']),
    renderEmail({ heading, body: bodyFor('old') }),
  );

  await send(
    newEmail,
    heading,
    renderText(heading, [`You're now down to attend ${eventTitle}, taking over from ${oldName}.`, 'If this was not expected, reply to this email.']),
    renderEmail({ heading, body: bodyFor('new') }),
  );
}

/** Confirms a cancellation request was received — not that it was approved. */
export async function sendCancellationRequested(input: {
  to: string;
  registrantName: string;
  eventTitle: string;
}): Promise<void> {
  const { to, registrantName, eventTitle } = input;
  const heading = `We received your cancellation request`;

  const body =
    p(`Hello ${escapeHtml(registrantName)},`) +
    p(
      `We've received your request to cancel your place at ${escapeHtml(eventTitle)}. Someone will review it and ` +
        `be in touch — nothing has changed yet, and your place is still held until then.`,
    ) +
    note('If you change your mind in the meantime, just reply to this email.');

  await send(
    to,
    heading,
    renderText(heading, [
      `We've received your request to cancel your place at ${eventTitle}.`,
      'Nothing has changed yet — your place is still held until someone reviews this.',
    ]),
    renderEmail({ heading, body }),
  );
}

/** Puts a cancellation request in front of an admin without waiting for the queue to be checked. */
export async function sendCancellationRequestedAdminAlert(input: {
  to: string;
  registrationId: string;
  registrantName: string;
  eventTitle: string;
  reason: string | null;
}): Promise<void> {
  const { to, registrationId, registrantName, eventTitle, reason } = input;
  const heading = `Cancellation requested: ${eventTitle}`;

  const body =
    p(`${escapeHtml(registrantName)} has asked to cancel their place at ${escapeHtml(eventTitle)}.`) +
    (reason ? p(escapeHtml(reason)) : '') +
    button('Review in admin', `${SITE}/admin/registrations`);

  await send(
    to,
    heading,
    renderText(heading, [
      `${registrantName} has asked to cancel their place at ${eventTitle}.`,
      ...(reason ? ['', reason] : []),
      '',
      `${SITE}/admin/registrations`,
      `(registration ${registrationId})`,
    ]),
    renderEmail({ heading, body }),
  );
}

/**
 * Tells admin a seat was just paid for and confirmed.
 *
 * Sent once per registration, from the same place the buyer's own
 * confirmation goes out — the two are the only signal admin gets that a sale
 * happened; there is no polling of the dashboard. Not sent for later
 * instalments on the same registration: "someone bought a place" is the event
 * worth a ping, and repeating it for every instalment would just teach admin
 * to ignore it.
 */
export async function sendRegistrationPaidAdminAlert(input: {
  to: string;
  registrationId: string;
  registrantName: string;
  buyerEmail: string;
  eventTitle: string;
  planName: string;
  amountCentavos: number;
  currency: string;
  receiptNo: string;
}): Promise<void> {
  const { to, registrationId, registrantName, buyerEmail, eventTitle, planName, amountCentavos, currency, receiptNo } =
    input;
  const heading = `Paid: ${eventTitle}`;

  const rows = [
    { label: 'Registrant', value: escapeHtml(registrantName) },
    { label: 'Email', value: escapeHtml(buyerEmail) },
    { label: 'Plan', value: escapeHtml(planName) },
    { label: 'Paid', value: escapeHtml(peso(amountCentavos, currency)) },
    { label: 'Receipt', value: escapeHtml(receiptNo) },
  ];

  const body =
    p(`${escapeHtml(registrantName)} just paid for a place at ${escapeHtml(eventTitle)}.`) +
    details(rows) +
    button('Review in admin', `${SITE}/admin/registrations`);

  await send(
    to,
    heading,
    renderText(heading, [
      `${registrantName} (${buyerEmail}) just paid for a place at ${eventTitle}.`,
      `Plan: ${planName}`,
      `Paid: ${peso(amountCentavos, currency)} (receipt ${receiptNo})`,
      '',
      `${SITE}/admin/registrations`,
      `(registration ${registrationId})`,
    ]),
    renderEmail({ heading, body }),
  );
}

/**
 * Tells a registrant their cancellation request was not approved.
 *
 * Says plainly that the place is still theirs and still due, because the
 * alternative is someone assuming they are cancelled, not paying, and finding
 * out in December. Ends with an opening to reply — a declined request is
 * usually the start of a conversation, not the end of one.
 */
export async function sendCancellationDeclined(input: {
  to: string;
  registrantName: string;
  eventTitle: string;
  reason: string | null;
}): Promise<void> {
  const { to, registrantName, eventTitle, reason } = input;
  const heading = `About your cancellation request`;

  const body =
    p(`Hello ${escapeHtml(registrantName)},`) +
    p(
      `We've looked at your request to cancel your place at ${escapeHtml(eventTitle)}, and we're not ` +
        `able to cancel it on this occasion.`,
    ) +
    (reason ? p(escapeHtml(reason)) : '') +
    p('Your place is still held, and any remaining payments are still due as scheduled.') +
    note('If circumstances have changed or this feels wrong, reply to this email — a person will read it.');

  await send(
    to,
    heading,
    renderText(heading, [
      `We're not able to cancel your place at ${eventTitle} on this occasion.`,
      ...(reason ? ['', reason] : []),
      '',
      'Your place is still held, and any remaining payments are still due as scheduled.',
      'If this feels wrong, reply to this email — a person will read it.',
    ]),
    renderEmail({ heading, body }),
  );
}

/**
 * The joining details on their own, sent on demand.
 *
 * Exists because a Zoom link is the one detail that changes after people have
 * already registered — the host reschedules the room, or the link was not
 * ready when the first registrations came in. Re-sending the whole
 * confirmation to say so would re-send a receipt for money that was taken
 * weeks ago, which reads as a second charge.
 *
 * Addressed to the **registrant**, not the buyer: a parent who paid for their
 * daughter's place is not the one who needs the link. Where the two are the
 * same address — which is the common case — this is the same person anyway,
 * and where they differ the caller is free to send twice.
 */
export async function sendJoinDetails(input: {
  to: string;
  registrantName: string;
  registrationId: string;
  event: EmailEvent;
  /** Set when a link that had already been sent has since changed. */
  updated?: boolean;
}): Promise<void> {
  const { event } = input;
  if (!event.join_url) return;

  const heading = input.updated
    ? `Updated joining details for ${event.title}`
    : `How to join ${event.title}`;

  const lead = input.updated
    ? `The joining link for ${escapeHtml(event.title)} has changed — please use the one below and ignore any earlier link.`
    : `Here is how to join ${escapeHtml(event.title)}, ${escapeHtml(input.registrantName)}.`;

  const body =
    p(lead) +
    details([
      { label: 'Event', value: escapeHtml(event.title) },
      { label: 'When', value: escapeHtml(whenEvent(event)) },
    ]) +
    joinBlock(event) +
    note('Keep this email — the link is also on your registration page, linked below.') +
    button('View your registration', registrationUrl(input.registrationId));

  // Re-issued with the same UID, so a calendar that already holds this event
  // updates the entry in place — new link in LOCATION and URL — instead of
  // producing a duplicate. The sequence must simply be larger than last time;
  // epoch seconds guarantees that without a column to count issues in.
  const invite = registrationInvite({
    registrationId: input.registrationId,
    event,
    attendeeEmail: input.to,
    attendeeName: input.registrantName,
    sequence: Math.floor(Date.now() / 1000),
  });

  await send(
    input.to,
    heading,
    renderText(heading, [
      input.updated
        ? `The joining link for ${event.title} has changed. Please use the one below and ignore any earlier link.`
        : `How to join ${event.title}.`,
      `When: ${whenEvent(event)}`,
      ...joinLines(event),
      '',
      registrationUrl(input.registrationId),
    ]),
    renderEmail({ preheader: `Joining details for ${event.title}.`, heading, body }),
    invite ? [invite] : undefined,
  );
}

/**
 * Reminds a confirmed registrant that the event is coming up (0054, phase 2).
 *
 * Mirrors `sendBookingReminder` in `booking-email.ts` — same one-time,
 * lead-window send — for the gap `registration-sweep.ts`'s header noted:
 * every reminder in that file is about a *payment*, and nothing ever reminded
 * someone the event itself was about to happen. A registrant confirmed
 * months out otherwise gets one email at registration and nothing again until
 * the day arrives.
 *
 * Carries the joining link when there is one, the same release rule
 * `sendJoinDetails` follows — this is a legitimate release, since only a
 * `confirmed` registration reaches the sweep's query.
 */
export async function sendEventReminder(input: {
  to: string;
  registrantName: string;
  registrationId: string;
  event: EmailEvent;
}): Promise<void> {
  const { event, registrantName, registrationId } = input;
  const heading = `${event.title} is coming up`;

  const body =
    p(`Hi ${escapeHtml(registrantName)}, a reminder that you're booked in.`) +
    details([
      { label: 'Event', value: escapeHtml(event.title) },
      { label: 'When', value: escapeHtml(whenEvent(event)) },
      ...(event.location ? [{ label: 'Where', value: escapeHtml(event.location) }] : []),
    ]) +
    joinBlock(event) +
    (event.venue_details ? note(escapeHtml(event.venue_details)) : '') +
    button('View your registration', registrationUrl(registrationId));

  await send(
    input.to,
    heading,
    renderText(heading, [
      `Hi ${registrantName}, a reminder that you're booked in.`,
      `When: ${whenEvent(event)}`,
      ...(event.location ? [`Where: ${event.location}`] : []),
      ...joinLines(event),
      '',
      registrationUrl(registrationId),
    ]),
    renderEmail({ preheader: `${event.title} is coming up.`, heading, body }),
  );
}

/**
 * Tells the facilitator hosting an event that someone has paid for a place.
 *
 * ## Why this is a separate send and not a CC on the attendee's confirmation
 *
 * Two reasons, either sufficient. A CC puts the host's personal address in a
 * header the attendee can read, on every registration — the host did not agree
 * to publish it. And the confirmation is written in the second person to the
 * person who just paid ("your place is held", "here is your joining link"); a
 * host reading that about their own event has to translate every sentence.
 *
 * ## Why it carries the roster count
 *
 * "Someone registered" is a notification. "Someone registered, that is 7 of 20"
 * is the thing a host actually needs, because the decision it feeds is whether
 * to promote the event again this week. It costs one count that the caller has
 * already loaded.
 *
 * ## What it deliberately omits
 *
 * No money. The host's cut is a payout question answered by the payouts screen,
 * against the ledger, after fees — quoting a gross ticket price here invites
 * them to expect that number and to query the difference every month. And no
 * `registrant_details`: dietary needs and emergency contacts belong on the
 * roster, behind auth, not scattered across an inbox. The link goes there.
 */
export async function sendRegistrationHostAlert(input: {
  to: string;
  hostName: string;
  eventId: string;
  event: EmailEvent;
  registrantName: string;
  registrantEmail: string;
  /** Confirmed registrations for this event, including the one just made. */
  seatsTaken: number;
  /** Null for an event with no cap. */
  capacity: number | null;
}): Promise<void> {
  const {
    to,
    hostName,
    eventId,
    event,
    registrantName,
    registrantEmail,
    seatsTaken,
    capacity,
  } = input;

  const eventTitle = event.title;
  const heading = `New registration: ${eventTitle}`;
  const count =
    capacity === null ? `${seatsTaken} registered so far` : `${seatsTaken} of ${capacity} places taken`;

  const rows = [
    { label: 'Who', value: escapeHtml(registrantName) },
    { label: 'Email', value: escapeHtml(registrantEmail) },
    { label: 'Event', value: escapeHtml(eventTitle) },
    { label: 'When', value: escapeHtml(whenEvent(event)) },
    { label: 'Registered', value: escapeHtml(count) },
  ];

  const body =
    p(`Hi ${escapeHtml(hostName)}, ${escapeHtml(registrantName)} has paid for a place at ${escapeHtml(eventTitle)}.`) +
    details(rows) +
    button('See the full roster', `${SITE}/facilitator/events/${eventId}`);

  await send(
    to,
    heading,
    renderText(heading, [
      `Hi ${hostName},`,
      '',
      `${registrantName} (${registrantEmail}) has paid for a place at ${eventTitle}.`,
      `That is ${count}.`,
      '',
      `See the full roster: ${SITE}/facilitator/events/${eventId}`,
    ]),
    renderEmail({ heading, body }),
  );
}

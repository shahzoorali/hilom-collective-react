/**
 * Booking notifications.
 *
 * Follows `enrollment-email.ts` exactly: SESv2 from ap-south-1 (the identity
 * with production access — see the long note in that file for why not
 * ap-southeast-1), and best-effort throughout. A send failure must never take
 * down a confirmation: by the time these run the money has moved and the slot
 * is held, and losing an email is recoverable in a way that losing a booking
 * is not.
 *
 * Both sides are notified on every state change. A facilitator who finds out
 * about a cancellation by sitting in an empty meeting room does not stay on the
 * platform, and that is a failure mode email is the entire fix for.
 *
 * Every template here composes from `email-layout.ts` rather than writing its
 * own markup — see that file for why email HTML looks the way it does.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { renderEmail, renderText, escapeHtml, p, note, details, button, link } from './email-layout.js';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <kumusta@hilomcollective.com>';

const ACCOUNT_BOOKINGS_URL = 'https://www.hilomcollective.com/account/bookings';
const FACILITATOR_BOOKINGS_URL = 'https://www.hilomcollective.com/facilitator/bookings';

/**
 * Formats an instant for a human, in a named zone, with the zone shown.
 *
 * The zone label is not decoration. A Manila facilitator with a client in
 * Sydney is the normal case, and "3:00 PM" without a zone is how someone
 * misses their session — so every rendered time in this file carries one.
 */
export function formatWhen(startsAt: string | Date, timezone: string): string {
  const date = startsAt instanceof Date ? startsAt : new Date(startsAt);
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

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
    console.warn('[booking-email] send failed — the booking itself is unaffected', {
      to,
      subject,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface BookingEmailContext {
  clientEmail: string;
  clientName?: string | null;
  facilitatorEmail: string;
  facilitatorName: string;
  serviceTitle: string;
  startsAt: string;
  /** The facilitator's zone — used for their copy of the email. */
  facilitatorTimezone: string;
  meetingUrl?: string | null;
  isFree: boolean;
}

/** The join row, which is either a link or an honest admission there isn't one. */
function joinDetail(meetingUrl?: string | null): { label: string; value: string } {
  return {
    label: 'Join',
    value: meetingUrl ? link(meetingUrl, meetingUrl) : 'Your facilitator will send joining details.',
  };
}

/** Sent to both parties the moment a booking becomes `confirmed`. */
export async function sendBookingConfirmed(ctx: BookingEmailContext): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);
  const joinLine = ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : 'Your facilitator will send joining details.';
  const rescheduleNote = ctx.isFree
    ? 'This is a complimentary call — a short conversation to see whether this facilitator is the right fit for you.'
    : 'You can reschedule or cancel from your Hilom account, up to 24 hours before the session starts.';

  const clientHtml = renderEmail({
    preheader: `${ctx.serviceTitle} with ${ctx.facilitatorName} — ${when}`,
    heading: 'Your session is confirmed',
    body:
      p(`You're booked in with <strong>${escapeHtml(ctx.facilitatorName)}</strong>. Here are the details.`) +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        { label: 'With', value: escapeHtml(ctx.facilitatorName) },
        { label: 'When', value: escapeHtml(when) },
        joinDetail(ctx.meetingUrl),
      ]) +
      button('View your bookings', ACCOUNT_BOOKINGS_URL) +
      note(rescheduleNote),
  });

  const clientText = renderText(`Your session is confirmed: ${ctx.serviceTitle} with ${ctx.facilitatorName}`, [
    `When: ${when}`,
    joinLine,
    '',
    rescheduleNote,
    '',
    `See your bookings: ${ACCOUNT_BOOKINGS_URL}`,
  ]);

  const facilitatorHtml = renderEmail({
    preheader: `${ctx.clientName || ctx.clientEmail} booked ${ctx.serviceTitle} — ${when}`,
    heading: 'You have a new booking',
    body:
      p('Someone has booked a session with you.') +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        {
          label: 'Client',
          value: `${escapeHtml(ctx.clientName || ctx.clientEmail)} (${escapeHtml(ctx.clientEmail)})`,
        },
        { label: 'When', value: escapeHtml(when) },
        joinDetail(ctx.meetingUrl),
      ]) +
      button('Open your calendar', FACILITATOR_BOOKINGS_URL),
  });

  const facilitatorText = renderText(`New booking: ${ctx.serviceTitle}`, [
    `Client: ${ctx.clientName || ctx.clientEmail} (${ctx.clientEmail})`,
    `When: ${when}`,
    joinLine,
    '',
    `See your calendar: ${FACILITATOR_BOOKINGS_URL}`,
  ]);

  await Promise.all([
    send(ctx.clientEmail, `Session confirmed: ${ctx.serviceTitle}`, clientText, clientHtml),
    send(ctx.facilitatorEmail, `New booking: ${ctx.serviceTitle}`, facilitatorText, facilitatorHtml),
  ]);
}

/**
 * Sent to both parties shortly before the session.
 *
 * Leads with the join button rather than pointing at the dashboard, because
 * the whole job of this email is to be the thing someone opens as the session
 * starts — one that says "go and look somewhere else for the link" has failed
 * at exactly the wrong moment.
 *
 * The client's copy deliberately does not offer rescheduling. By the time this
 * lands, the 24-hour window has closed (see canReschedule in
 * booking-domain.ts), so inviting them to move it would be inviting a click
 * into a refusal.
 */
export async function sendBookingReminder(ctx: BookingEmailContext): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);
  const joinLine = ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : 'Your facilitator will send joining details.';

  const clientHtml = renderEmail({
    preheader: `${ctx.serviceTitle} with ${ctx.facilitatorName} — ${when}`,
    heading: 'Your session is coming up',
    body:
      p(`A reminder that you're seeing <strong>${escapeHtml(ctx.facilitatorName)}</strong> tomorrow.`) +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        { label: 'With', value: escapeHtml(ctx.facilitatorName) },
        { label: 'When', value: escapeHtml(when) },
      ]) +
      (ctx.meetingUrl ? button('Join the session', ctx.meetingUrl) : '') +
      note(
        ctx.meetingUrl
          ? "If you can't make it, let your facilitator know as soon as you can."
          : "Your facilitator will send joining details. If you can't make it, let them know as soon as you can.",
      ),
  });

  const clientText = renderText(`Coming up: ${ctx.serviceTitle} with ${ctx.facilitatorName}`, [
    `When: ${when}`,
    joinLine,
    '',
    "If you can't make it, let your facilitator know as soon as you can.",
  ]);

  const facilitatorHtml = renderEmail({
    preheader: `${ctx.serviceTitle} with ${ctx.clientName || ctx.clientEmail} — ${when}`,
    heading: 'A session is coming up',
    body:
      p("A reminder of tomorrow's session.") +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        {
          label: 'Client',
          value: `${escapeHtml(ctx.clientName || ctx.clientEmail)} (${escapeHtml(ctx.clientEmail)})`,
        },
        { label: 'When', value: escapeHtml(when) },
      ]) +
      (ctx.meetingUrl ? button('Join the session', ctx.meetingUrl) : ''),
  });

  const facilitatorText = renderText(`Coming up: ${ctx.serviceTitle}`, [
    `Client: ${ctx.clientName || ctx.clientEmail} (${ctx.clientEmail})`,
    `When: ${when}`,
    joinLine,
  ]);

  await Promise.all([
    send(ctx.clientEmail, `Reminder: ${ctx.serviceTitle} tomorrow`, clientText, clientHtml),
    send(ctx.facilitatorEmail, `Reminder: ${ctx.serviceTitle} tomorrow`, facilitatorText, facilitatorHtml),
  ]);
}

/** Sent to both parties on cancellation, whoever initiated it. */
export async function sendBookingCancelled(
  ctx: BookingEmailContext,
  detail: { cancelledBy: string; refundNote: string },
): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);
  // Named explicitly rather than "client or else facilitator": an admin
  // cancellation is a third case, and falling through to "the facilitator"
  // would tell both parties the facilitator pulled out of a session they had
  // no part in cancelling.
  const who =
    detail.cancelledBy === 'client'
      ? 'the client'
      : detail.cancelledBy === 'admin'
        ? 'Hilom Collective'
        : 'the facilitator';

  const html = renderEmail({
    preheader: `${ctx.serviceTitle} on ${when} was cancelled`,
    heading: 'This session has been cancelled',
    body:
      p(`The session below was cancelled by ${escapeHtml(who)}.`) +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        { label: 'Was', value: escapeHtml(when) },
      ]) +
      note(escapeHtml(detail.refundNote)),
  });

  const text = renderText(`Cancelled: ${ctx.serviceTitle}`, [
    `When: ${when}`,
    `Cancelled by ${who}.`,
    '',
    detail.refundNote,
  ]);

  await Promise.all([
    send(ctx.clientEmail, `Cancelled: ${ctx.serviceTitle}`, text, html),
    send(ctx.facilitatorEmail, `Cancelled: ${ctx.serviceTitle}`, text, html),
  ]);
}

/** Sent to both parties when a booking moves to a new time. */
export async function sendBookingRescheduled(
  ctx: BookingEmailContext,
  previousStartsAt: string,
): Promise<void> {
  const was = formatWhen(previousStartsAt, ctx.facilitatorTimezone);
  const now = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);

  const html = renderEmail({
    preheader: `${ctx.serviceTitle} moved to ${now}`,
    heading: 'This session has moved',
    body:
      p('The session below has been rescheduled. Nothing was charged again.') +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        { label: 'Was', value: `<span style="text-decoration:line-through;">${escapeHtml(was)}</span>` },
        { label: 'Now', value: escapeHtml(now) },
        joinDetail(ctx.meetingUrl),
      ]) +
      button('View your bookings', ACCOUNT_BOOKINGS_URL),
  });

  const text = renderText(`Moved: ${ctx.serviceTitle}`, [
    `Was: ${was}`,
    `Now: ${now}`,
    ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : 'Your facilitator will send joining details.',
    '',
    'Nothing was charged again.',
  ]);

  await Promise.all([
    send(ctx.clientEmail, `Moved: ${ctx.serviceTitle}`, text, html),
    send(ctx.facilitatorEmail, `Moved: ${ctx.serviceTitle}`, text, html),
  ]);
}

/** Sent when an admin approves a facilitator application. */
export async function sendFacilitatorApproved(to: string, displayName: string): Promise<void> {
  const dashboard = 'https://www.hilomcollective.com/facilitator';

  const html = renderEmail({
    preheader: 'Set up your services and availability to go live on Hilom.',
    heading: `You're approved, ${displayName}`,
    body:
      p('Welcome to Hilom Collective. Your facilitator account is ready.') +
      p(
        'Before clients can find you, set up the sessions you offer and the hours you keep. ' +
          "We'll publish your profile to the directory once it's ready.",
      ) +
      button('Set up your profile', dashboard) +
      note('Once your profile is published, clients can find and book you directly.'),
  });

  const text = renderText(`You're approved, ${displayName}.`, [
    'Welcome to Hilom Collective. Your facilitator account is ready.',
    '',
    'Set up your services and availability before you go live:',
    dashboard,
    '',
    'Once your profile is published, clients can find and book you.',
  ]);

  await send(to, 'Your Hilom facilitator application is approved', text, html);
}

/**
 * Tells a facilitator that automatic meeting-link creation failed for a
 * confirmed session and they need to send a link by hand.
 *
 * Only sent when there was no fallback — the service has an integrated
 * provider but no backup `meeting_url`. It goes *alongside* the normal "new
 * booking" email, not instead of it: the client has a real, paid, confirmed
 * session, and the gap is only that nobody has a way to join yet.
 */
export async function sendMeetingLinkFailed(ctx: {
  facilitatorEmail: string;
  facilitatorName: string;
  facilitatorTimezone: string;
  clientName: string;
  serviceTitle: string;
  startsAt: string | Date;
}): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);

  const html = renderEmail({
    preheader: `Action needed: ${ctx.serviceTitle} on ${when} has no meeting link yet`,
    heading: 'A booking needs a meeting link',
    body:
      p(
        `We couldn't create the video link for your upcoming session automatically, and you ` +
          `don't have a backup link set on this service.`,
      ) +
      details([
        { label: 'Session', value: escapeHtml(ctx.serviceTitle) },
        { label: 'Client', value: escapeHtml(ctx.clientName) },
        { label: 'When', value: escapeHtml(when) },
      ]) +
      p(
        `Please message the client with a joining link before the session, and check your ` +
          `connected account under Connections. Adding a backup link to the service will ` +
          `prevent this next time.`,
      ) +
      button('Open your bookings', FACILITATOR_BOOKINGS_URL),
  });

  const text = renderText('A booking needs a meeting link', [
    "We couldn't create the video link for your session automatically, and no backup link is set.",
    '',
    `Session: ${ctx.serviceTitle}`,
    `Client: ${ctx.clientName}`,
    `When: ${when}`,
    '',
    'Send the client a joining link before the session, and check Connections in your dashboard.',
    FACILITATOR_BOOKINGS_URL,
  ]);

  await send(ctx.facilitatorEmail, `Action needed: meeting link for ${ctx.serviceTitle}`, text, html);
}

const FACILITATOR_EARNINGS_URL = 'https://www.hilomcollective.com/facilitator/earnings';

const peso = (centavos: number, currency = 'PHP'): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 2 }).format(
    centavos / 100,
  );

/**
 * A period like "1–15 September 2026", or "26 August – 3 September 2026".
 *
 * Exported for the test that pins the exclusive-end handling and the
 * same-month collapse — both easy to get subtly wrong.
 */
export function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  // period_end is exclusive (see 0013), so the last covered day is the one before.
  const end = new Date(new Date(endIso).getTime() - 86_400_000);
  const day = (d: Date) => new Intl.DateTimeFormat('en-PH', { day: 'numeric', timeZone: 'Asia/Manila' }).format(d);
  const monthYear = (d: Date) =>
    new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' }).format(d);
  return monthYear(start) === monthYear(end)
    ? `${day(start)}–${day(end)} ${monthYear(end)}`
    : `${day(start)} ${monthYear(start)} – ${day(end)} ${monthYear(end)}`;
}

/**
 * Tells a facilitator a payout has been sent.
 *
 * Hilom transfers each facilitator's share by hand, so this is the "the money
 * has left our account" moment — the one a marketplace most needs to feel
 * reliable, and which was previously silent (a facilitator only found out by
 * opening the Earnings tab).
 *
 * Shows the same arithmetic the Earnings tab and the admin Payouts screen show
 * — gross, minus Hilom's fee, minus the payment-processing cost, equals the
 * amount transferred — so the number is never a surprise and any question is
 * answerable from the email itself.
 */
export async function sendPayoutPaid(ctx: {
  facilitatorEmail: string;
  facilitatorName: string;
  periodStart: string;
  periodEnd: string;
  grossCentavos: number;
  platformFeeCentavos: number;
  processingFeeCentavos: number;
  netCentavos: number;
  currency: string;
  reference: string | null;
}): Promise<void> {
  const period = formatPeriod(ctx.periodStart, ctx.periodEnd);
  const amount = peso(ctx.netCentavos, ctx.currency);

  const rows = [
    { label: 'For sessions in', value: period },
    { label: 'Gross', value: peso(ctx.grossCentavos, ctx.currency) },
    { label: 'Hilom platform fee', value: `−${peso(ctx.platformFeeCentavos, ctx.currency)}` },
    ...(ctx.processingFeeCentavos > 0
      ? [{ label: 'Payment processing', value: `−${peso(ctx.processingFeeCentavos, ctx.currency)}` }]
      : []),
    { label: 'Transferred to you', value: amount },
    ...(ctx.reference ? [{ label: 'Reference', value: escapeHtml(ctx.reference) }] : []),
  ];

  const html = renderEmail({
    preheader: `${amount} for your sessions in ${period} is on its way.`,
    heading: 'You’ve been paid',
    body:
      p(
        `Hi ${escapeHtml(ctx.facilitatorName)}, we’ve transferred <strong>${amount}</strong> to your ` +
          `registered bank account for your completed sessions in ${escapeHtml(period)}.`,
      ) +
      details(rows) +
      button('See your earnings', FACILITATOR_EARNINGS_URL) +
      note('Bank transfers usually arrive within one to three working days. If it hasn’t landed after that, reply to this email.'),
  });

  const text = renderText('You’ve been paid', [
    `Hi ${ctx.facilitatorName},`,
    '',
    `We’ve transferred ${amount} to your registered bank account for your completed sessions in ${period}.`,
    '',
    `For sessions in: ${period}`,
    `Gross: ${peso(ctx.grossCentavos, ctx.currency)}`,
    `Hilom platform fee: -${peso(ctx.platformFeeCentavos, ctx.currency)}`,
    ...(ctx.processingFeeCentavos > 0
      ? [`Payment processing: -${peso(ctx.processingFeeCentavos, ctx.currency)}`]
      : []),
    `Transferred to you: ${amount}`,
    ...(ctx.reference ? [`Reference: ${ctx.reference}`] : []),
    '',
    'Bank transfers usually arrive within one to three working days.',
    '',
    `See your earnings: ${FACILITATOR_EARNINGS_URL}`,
  ]);

  await send(ctx.facilitatorEmail, `You've been paid — ${amount}`, text, html);
}

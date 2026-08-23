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
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <hello@hilomcollective.com>';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

/** Sent to both parties the moment a booking becomes `confirmed`. */
export async function sendBookingConfirmed(ctx: BookingEmailContext): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);
  const joinLine = ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : 'Your facilitator will send joining details.';

  const clientText = [
    `Your session is confirmed: ${ctx.serviceTitle} with ${ctx.facilitatorName}`,
    '',
    `When: ${when}`,
    joinLine,
    '',
    ctx.isFree
      ? 'This is a complimentary call — a short conversation to see whether this facilitator is the right fit for you.'
      : 'You can reschedule or cancel from your Hilom account.',
    '',
    'See your bookings: https://www.hilomcollective.com/account/bookings',
  ].join('\n');

  const clientHtml = `
    <p><strong>Your session is confirmed:</strong> ${escapeHtml(ctx.serviceTitle)} with ${escapeHtml(ctx.facilitatorName)}</p>
    <p><strong>When:</strong> ${escapeHtml(when)}</p>
    <p>${ctx.meetingUrl ? `<a href="${escapeHtml(ctx.meetingUrl)}">Join the session</a>` : 'Your facilitator will send joining details.'}</p>
    <p style="color:#666;font-size:14px;">${
      ctx.isFree
        ? 'This is a complimentary call — a short conversation to see whether this facilitator is the right fit for you.'
        : 'You can reschedule or cancel from your Hilom account.'
    }</p>
    <p style="color:#666;font-size:14px;"><a href="https://www.hilomcollective.com/account/bookings">See your bookings</a></p>
  `;

  const facilitatorText = [
    `New booking: ${ctx.serviceTitle}`,
    '',
    `Client: ${ctx.clientName || ctx.clientEmail} (${ctx.clientEmail})`,
    `When: ${when}`,
    joinLine,
    '',
    'See your calendar: https://www.hilomcollective.com/facilitator/bookings',
  ].join('\n');

  const facilitatorHtml = `
    <p><strong>New booking:</strong> ${escapeHtml(ctx.serviceTitle)}</p>
    <p><strong>Client:</strong> ${escapeHtml(ctx.clientName || ctx.clientEmail)} (${escapeHtml(ctx.clientEmail)})</p>
    <p><strong>When:</strong> ${escapeHtml(when)}</p>
    <p style="color:#666;font-size:14px;"><a href="https://www.hilomcollective.com/facilitator/bookings">See your calendar</a></p>
  `;

  await Promise.all([
    send(ctx.clientEmail, `Session confirmed: ${ctx.serviceTitle}`, clientText, clientHtml),
    send(ctx.facilitatorEmail, `New booking: ${ctx.serviceTitle}`, facilitatorText, facilitatorHtml),
  ]);
}

/**
 * Sent to both parties shortly before the session.
 *
 * Carries the join link rather than pointing at the dashboard, because the
 * whole job of this email is to be the thing someone opens at the moment the
 * session starts — one that says "go and look somewhere else for the link" has
 * failed at exactly the wrong time.
 *
 * The client's copy deliberately does not offer rescheduling. By the time this
 * lands, the 24-hour window has closed (see canReschedule in
 * booking-domain.ts), so inviting them to move it would be inviting a click
 * into a refusal.
 */
export async function sendBookingReminder(ctx: BookingEmailContext): Promise<void> {
  const when = formatWhen(ctx.startsAt, ctx.facilitatorTimezone);
  const joinLine = ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : 'Your facilitator will send joining details.';

  const clientText = [
    `Coming up: ${ctx.serviceTitle} with ${ctx.facilitatorName}`,
    '',
    `When: ${when}`,
    joinLine,
    '',
    "If you can't make it, let your facilitator know as soon as you can.",
  ].join('\n');

  const clientHtml = `
    <p><strong>Coming up:</strong> ${escapeHtml(ctx.serviceTitle)} with ${escapeHtml(ctx.facilitatorName)}</p>
    <p><strong>When:</strong> ${escapeHtml(when)}</p>
    <p>${ctx.meetingUrl ? `<a href="${escapeHtml(ctx.meetingUrl)}">Join the session</a>` : 'Your facilitator will send joining details.'}</p>
    <p style="color:#666;font-size:14px;">If you can't make it, let your facilitator know as soon as you can.</p>
  `;

  const facilitatorText = [
    `Coming up: ${ctx.serviceTitle}`,
    '',
    `Client: ${ctx.clientName || ctx.clientEmail} (${ctx.clientEmail})`,
    `When: ${when}`,
    joinLine,
  ].join('\n');

  const facilitatorHtml = `
    <p><strong>Coming up:</strong> ${escapeHtml(ctx.serviceTitle)}</p>
    <p><strong>Client:</strong> ${escapeHtml(ctx.clientName || ctx.clientEmail)} (${escapeHtml(ctx.clientEmail)})</p>
    <p><strong>When:</strong> ${escapeHtml(when)}</p>
    <p>${ctx.meetingUrl ? `<a href="${escapeHtml(ctx.meetingUrl)}">Join the session</a>` : ''}</p>
  `;

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

  const text = [
    `Cancelled: ${ctx.serviceTitle}`,
    '',
    `When: ${when}`,
    `Cancelled by ${who}.`,
    detail.refundNote,
  ].join('\n');

  const html = `
    <p><strong>Cancelled:</strong> ${escapeHtml(ctx.serviceTitle)}</p>
    <p><strong>When:</strong> ${escapeHtml(when)}</p>
    <p>Cancelled by ${escapeHtml(who)}.</p>
    <p style="color:#666;font-size:14px;">${escapeHtml(detail.refundNote)}</p>
  `;

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

  const text = [
    `Moved: ${ctx.serviceTitle}`,
    '',
    `Was: ${was}`,
    `Now: ${now}`,
    ctx.meetingUrl ? `Join here: ${ctx.meetingUrl}` : '',
  ].join('\n');

  const html = `
    <p><strong>Moved:</strong> ${escapeHtml(ctx.serviceTitle)}</p>
    <p><s>${escapeHtml(was)}</s></p>
    <p><strong>${escapeHtml(now)}</strong></p>
    ${ctx.meetingUrl ? `<p><a href="${escapeHtml(ctx.meetingUrl)}">Join the session</a></p>` : ''}
  `;

  await Promise.all([
    send(ctx.clientEmail, `Moved: ${ctx.serviceTitle}`, text, html),
    send(ctx.facilitatorEmail, `Moved: ${ctx.serviceTitle}`, text, html),
  ]);
}

/** Sent when an admin approves a facilitator application. */
export async function sendFacilitatorApproved(to: string, displayName: string): Promise<void> {
  const text = [
    `You're approved, ${displayName}.`,
    '',
    'Set up your services and availability before you go live:',
    'https://www.hilomcollective.com/facilitator',
    '',
    'Once your profile is published, clients can find and book you.',
  ].join('\n');

  const html = `
    <p><strong>You're approved, ${escapeHtml(displayName)}.</strong></p>
    <p>Set up your <a href="https://www.hilomcollective.com/facilitator">services and availability</a> before you go live.</p>
    <p style="color:#666;font-size:14px;">Once your profile is published, clients can find and book you.</p>
  `;

  await send(to, 'Your Hilom facilitator application is approved', text, html);
}

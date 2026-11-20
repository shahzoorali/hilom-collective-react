/**
 * Emails for package instalments (0077).
 *
 * Payment reminders are separate from session reminders on purpose: a client
 * who has paid in full still gets every session reminder (booking-sweep), and
 * these stop the moment a payment clears because the sweep only looks at
 * outstanding charges.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { renderEmail, renderText, escapeHtml, p, note, details, button } from './email-layout.js';
import type { ReminderTier } from './package-installments.js';

const sesClient = new SESv2Client({ region: 'ap-south-1' });
const SENDER = 'Hilom Collective <kumusta@hilomcollective.com>';
const ADMIN_ALERT_EMAIL = 'kumusta@hilomcollective.com';
const SITE = 'https://www.hilomcollective.com';

/** Where the client pays: their bookings page opens the checkout for this payment. */
export const packagePayUrl = (packageId: string, chargeId: string): string =>
  `${SITE}/account/bookings?package=${encodeURIComponent(packageId)}&pay=${encodeURIComponent(chargeId)}`;

const FACILITATOR_BOOKINGS_URL = `${SITE}/facilitator/bookings`;

const peso = (centavos: number, currency = 'PHP'): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 2 }).format(centavos / 100);

const when = (iso: string, timeZone = 'Asia/Manila'): string =>
  new Intl.DateTimeFormat('en-PH', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));

/** Throws on failure, so the sweep can release its claim and retry next run. */
async function sendOrThrow(to: string, subject: string, text: string, html: string): Promise<void> {
  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } },
    }),
  );
}

/** Best effort: the payment is recorded either way. */
async function sendQuietly(to: string, subject: string, text: string, html: string): Promise<void> {
  try {
    await sendOrThrow(to, subject, text, html);
  } catch (err) {
    console.warn('[package-email] send failed; the payment itself is unaffected', {
      subject,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const TIER_LEAD: Record<ReminderTier, string> = {
  '7d': 'A payment for your package is due in a week, before your next session.',
  '3d': 'A payment for your package is due in 3 days, before your next session.',
  day_of: 'A payment for your package is due today, before your session.',
};

export interface PackageChargeContext {
  clientEmail: string;
  clientName: string | null;
  clientTimezone: string | null;
  facilitatorEmail: string;
  facilitatorName: string;
  serviceTitle: string;
  packageId: string;
  chargeId: string;
  label: string;
  amountCentavos: number;
  currency: string;
}

export async function sendPackageChargeReminder(
  c: PackageChargeContext & { tier: ReminderTier; dueAt: string; sessionNumber: number },
): Promise<void> {
  const lead = TIER_LEAD[c.tier];
  const subject = `${c.tier === 'day_of' ? 'Due today' : 'Payment reminder'}: ${peso(c.amountCentavos, c.currency)} for ${c.serviceTitle}`;
  const url = packagePayUrl(c.packageId, c.chargeId);
  const due = when(c.dueAt, c.clientTimezone ?? 'Asia/Manila');
  const html = renderEmail({
    preheader: lead,
    heading: subject,
    body:
      p(`Hello ${escapeHtml(c.clientName || 'there')},`) +
      p(escapeHtml(lead)) +
      details([
        { label: 'Package', value: escapeHtml(`${c.serviceTitle} with ${c.facilitatorName}`) },
        { label: 'Payment', value: escapeHtml(c.label) },
        { label: 'Amount due', value: escapeHtml(peso(c.amountCentavos, c.currency)) },
        { label: 'Pay by', value: escapeHtml(`${due} (session ${c.sessionNumber})`) },
      ]) +
      button('Pay now', url) +
      note('Already paid? You can ignore this; reminders stop as soon as a payment clears.'),
  });
  const text = renderText(subject, [
    lead,
    '',
    `${c.label}: ${peso(c.amountCentavos, c.currency)}`,
    `Pay by: ${due} (session ${c.sessionNumber})`,
    '',
    `Pay now: ${url}`,
  ]);
  await sendOrThrow(c.clientEmail, subject, text, html);
}

/** Confirmation to the client and the facilitator, with a copy to the team. */
export async function sendPackageChargePaid(
  c: PackageChargeContext & { paidCount: number; totalCount: number; remainingCentavos: number },
): Promise<void> {
  const status =
    c.remainingCentavos > 0
      ? `${c.paidCount} of ${c.totalCount} payments made; ${peso(c.remainingCentavos, c.currency)} still to pay.`
      : 'The package is now fully paid.';
  const rows = [
    { label: 'Package', value: escapeHtml(`${c.serviceTitle} with ${c.facilitatorName}`) },
    { label: 'Payment', value: escapeHtml(c.label) },
    { label: 'Amount', value: escapeHtml(peso(c.amountCentavos, c.currency)) },
    { label: 'Status', value: escapeHtml(status) },
  ];

  const clientSubject = `Payment received: ${peso(c.amountCentavos, c.currency)} for ${c.serviceTitle}`;
  await sendQuietly(
    c.clientEmail,
    clientSubject,
    renderText(clientSubject, [`Thank you. ${c.label} is paid.`, status]),
    renderEmail({
      heading: clientSubject,
      body: p(`Hello ${escapeHtml(c.clientName || 'there')},`) + p(`Thank you, we've received ${escapeHtml(c.label.toLowerCase())}.`) + details(rows),
    }),
  );

  const who = c.clientName || c.clientEmail;
  const facSubject = `${who} paid ${peso(c.amountCentavos, c.currency)} for ${c.serviceTitle}`;
  const facHtml = renderEmail({
    heading: facSubject,
    body: details([{ label: 'Client', value: escapeHtml(`${who} <${c.clientEmail}>`) }, ...rows]) + button('Open bookings', FACILITATOR_BOOKINGS_URL),
  });
  const facText = renderText(facSubject, [`${c.label}: ${peso(c.amountCentavos, c.currency)}`, status]);
  if (c.facilitatorEmail) await sendQuietly(c.facilitatorEmail, facSubject, facText, facHtml);
  await sendQuietly(ADMIN_ALERT_EMAIL, `[Package] ${facSubject}`, facText, facHtml);
}

/** Once per charge, when its session starts with the payment still open. */
export async function sendPackageChargeOverdue(c: PackageChargeContext & { dueAt: string }): Promise<void> {
  const who = c.clientName || c.clientEmail;
  const subject = `Overdue: ${who} has not paid ${peso(c.amountCentavos, c.currency)} for ${c.serviceTitle}`;
  const html = renderEmail({
    heading: subject,
    body:
      p('This payment was due before a session that has now started. Nothing has been cancelled; this is for you to follow up.') +
      details([
        { label: 'Client', value: escapeHtml(`${who} <${c.clientEmail}>`) },
        { label: 'Payment', value: escapeHtml(c.label) },
        { label: 'Amount', value: escapeHtml(peso(c.amountCentavos, c.currency)) },
        { label: 'Was due', value: escapeHtml(when(c.dueAt)) },
      ]),
  });
  const text = renderText(subject, [`${c.label}: ${peso(c.amountCentavos, c.currency)}`, `Was due: ${when(c.dueAt)}`]);
  if (c.facilitatorEmail) await sendQuietly(c.facilitatorEmail, subject, text, html);
  await sendQuietly(ADMIN_ALERT_EMAIL, `[Package] ${subject}`, text, html);
}

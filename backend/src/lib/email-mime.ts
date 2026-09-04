/**
 * Sends an email carrying an iCalendar attachment, as raw MIME.
 *
 * Every other sender in this codebase uses SESv2's `Content.Simple`, which
 * only carries a text part and an HTML part — no attachments. That is fine
 * for a notification, but wrong for a *calendar invite*: Gmail and Outlook
 * only render Yes/No/Maybe buttons for a message whose `.ics` arrives as a
 * `text/calendar; method=REQUEST` MIME part, not as a link or a plain
 * attachment. Getting that requires `Content.Raw` — a hand-assembled message
 * — because SESv2 has no structured "attachment" field.
 *
 * Written by hand rather than pulled from npm, for the same reason
 * `ical.ts` is: this is a fixed, small MIME shape (multipart/mixed wrapping
 * multipart/alternative plus one calendar part), not a general mail
 * composer, and it is the one piece of this stack that would otherwise pull
 * in a mail-building dependency for about sixty lines.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

/** RFC 2045 wants base64 body lines no longer than 76 characters. */
function base64Lines(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.replace(/(.{76})/g, '$1\r\n');
}

/** RFC 2047 encoded-word, for a subject line that may carry non-ASCII text. */
function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** A boundary string collision-free enough for a single outgoing message. */
function boundaryFor(part: string): string {
  return `hilom-${part}-${Math.random().toString(36).slice(2)}`;
}

export interface InviteEmailInput {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  ics: string;
  icsMethod: 'REQUEST' | 'CANCEL';
}

/**
 * Best-effort, exactly like the plain `send()` in every sibling module: by
 * the time this runs the booking is already confirmed, moved, or cancelled,
 * and a failed email must never be the thing that fails the booking.
 */
export async function sendWithInvite(input: InviteEmailInput): Promise<void> {
  const mixed = boundaryFor('mixed');
  const alt = boundaryFor('alt');

  const raw =
    `From: ${input.from}\r\n` +
    `To: ${input.to}\r\n` +
    `Subject: ${encodeSubject(input.subject)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${mixed}"\r\n` +
    `\r\n` +
    `--${mixed}\r\n` +
    `Content-Type: multipart/alternative; boundary="${alt}"\r\n` +
    `\r\n` +
    `--${alt}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${base64Lines(input.text)}\r\n` +
    `--${alt}\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n` +
    `${base64Lines(input.html)}\r\n` +
    `--${alt}--\r\n` +
    `--${mixed}\r\n` +
    // `method=` on the Content-Type, not only inside the .ics body, is what
    // Gmail and Outlook actually key off to draw invite controls rather than
    // showing a generic attachment.
    `Content-Type: text/calendar; charset="UTF-8"; method=${input.icsMethod}\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="invite.ics"\r\n` +
    `\r\n` +
    `${base64Lines(input.ics)}\r\n` +
    `--${mixed}--\r\n`;

  try {
    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: input.from,
        Destination: { ToAddresses: [input.to] },
        Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
      }),
    );
  } catch (err) {
    console.warn('[email-mime] invite send failed — the booking itself is unaffected', {
      to: input.to,
      subject: input.subject,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

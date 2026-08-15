/**
 * POST /community/submit
 *
 * The "Join Our Community" form has no mailing-list/CRM behind it yet — this
 * just relays the submission to kumusta@hilomcollective.com via SES so the
 * team sees it immediately, rather than it going nowhere.
 *
 * SES sends from ap-south-1 (Mumbai), not this stack's usual ap-southeast-1:
 * hilomcollective.com is already a verified, DKIM-signed domain identity
 * there with production access, so sending from there needed no new identity
 * verification or DNS changes.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ok, badRequest, serverError } from '../lib/http.js';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const RECIPIENT = 'kumusta@hilomcollective.com';
const SENDER = 'Hilom Collective Website <website@hilomcollective.com>';

// Deliberately loose: this only gates what reaches SES, not what counts as a
// deliverable address — SES itself will bounce anything genuinely invalid.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SubmitBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  interests?: string[];
  message?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function submit(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: SubmitBody;
  try {
    body = JSON.parse(event.body ?? '{}') as SubmitBody;
  } catch {
    return badRequest('Malformed body');
  }

  const firstName = body.firstName?.trim();
  const lastName = body.lastName?.trim();
  const email = body.email?.trim().toLowerCase();
  const interests = Array.isArray(body.interests) ? body.interests.filter((i) => typeof i === 'string') : [];
  const message = body.message?.trim() ?? '';

  if (!firstName) return badRequest('Missing firstName');
  if (!lastName) return badRequest('Missing lastName');
  if (!email || !EMAIL_RE.test(email)) return badRequest('A valid email is required');

  const fullName = `${firstName} ${lastName}`;
  const interestsText = interests.length > 0 ? interests.join(', ') : 'None selected';

  const textBody = [
    `New community signup from ${fullName} <${email}>`,
    '',
    `Interested in: ${interestsText}`,
    '',
    'Message:',
    message || '(none)',
  ].join('\n');

  const htmlBody = `
    <p><strong>New community signup from ${escapeHtml(fullName)} &lt;${escapeHtml(email)}&gt;</strong></p>
    <p><strong>Interested in:</strong> ${escapeHtml(interestsText)}</p>
    <p><strong>Message:</strong><br>${escapeHtml(message || '(none)').replace(/\n/g, '<br>')}</p>
  `;

  try {
    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [RECIPIENT] },
        // Lets the team just hit "Reply" to respond straight to the submitter.
        ReplyToAddresses: [email],
        Content: {
          Simple: {
            Subject: { Data: `New community signup: ${fullName}` },
            Body: {
              Text: { Data: textBody },
              Html: { Data: htmlBody },
            },
          },
        },
      }),
    );

    return ok({ sent: true });
  } catch (err) {
    return serverError('community.submit', err);
  }
}

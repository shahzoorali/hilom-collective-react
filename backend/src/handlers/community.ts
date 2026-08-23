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
import { verifyRecaptcha } from '../lib/recaptcha.js';
import { renderEmail, renderText, escapeHtml, p, note, details, link } from '../lib/email-layout.js';

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
  captchaToken?: string;
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

  if (!(await verifyRecaptcha(body.captchaToken, 'community_submit'))) {
    return badRequest('Captcha check failed — please try again.');
  }

  const fullName = `${firstName} ${lastName}`;
  const interestsText = interests.length > 0 ? interests.join(', ') : 'None selected';

  const textBody = renderText('New community signup', [
    `Name: ${fullName}`,
    `Email: ${email}`,
    `Interested in: ${interestsText}`,
    '',
    'Message:',
    message || '(none)',
    '',
    'Reply to this email to reach them directly.',
  ]);

  // Branded like every other Hilom email even though this one goes to the
  // team rather than a member: it lands in the same inbox as replies from
  // people who received the outward-facing ones, and a bare unstyled relay
  // reads as a different system.
  const htmlBody = renderEmail({
    preheader: `${fullName} <${email}> — interested in ${interestsText}`,
    heading: 'New community signup',
    body:
      details([
        { label: 'Name', value: escapeHtml(fullName) },
        { label: 'Email', value: link(email, `mailto:${email}`) },
        { label: 'Interested in', value: escapeHtml(interestsText) },
      ]) +
      p(`<strong>Message</strong><br>${escapeHtml(message || '(none)').replace(/\n/g, '<br>')}`) +
      note('Reply to this email to reach them directly.'),
  });

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

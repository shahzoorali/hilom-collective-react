/**
 * Transactional account emails, sent via SES instead of Cognito's built-in
 * (sandboxed, `no-reply@verificationemail.com`-branded) email sending.
 *
 * SES sends from ap-south-1 (Mumbai), not this stack's usual ap-southeast-1:
 * hilomcollective.com is already a verified, DKIM-signed domain identity
 * there with production access — see community.ts for the same pattern.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { renderEmail, renderText, escapeHtml, p, note, details, button, link } from './email-layout.js';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <noreply@hilomcollective.com>';

/** Hosted UI's own sign-in page, which has a built-in "Forgot your password?" link. */
const LOGIN_URL =
  'https://auth.hilomcollective.com/login' +
  '?client_id=29bo0gpj7j9u7ofbcii22emj8l&response_type=code&scope=openid+email+profile' +
  '&redirect_uri=https%3A%2F%2Fhilomcollective.com%2Fauth%2Fcallback';

/**
 * Sent once, right after a buyer's Cognito account is first admin-created.
 * Cognito's own welcome email is suppressed (MessageAction: 'SUPPRESS' in
 * ensureCognitoUser) in favor of this — the account has no password yet, so
 * the buyer is walked through Hosted UI's "Forgot your password?" flow to
 * set their own, rather than being handed a Cognito temporary password.
 */
export async function sendAccountCreatedEmail(email: string, firstname: string): Promise<void> {
  const textBody = renderText(`Welcome to Hilom Collective, ${firstname}`, [
    'Your Hilom Learning Hub account has been created.',
    '',
    `Username: ${email}`,
    '',
    'Your account does not have a password yet. To set one:',
    '',
    `1. Open the sign-in page: ${LOGIN_URL}`,
    '2. Click "Forgot your password?"',
    '3. Enter the username above.',
    '4. Follow the emailed instructions to create your password.',
    '',
    "Once you're signed in, your learning dashboard and courses are all in one place.",
    '',
    'Need a hand? Email us at kumusta@hilomcollective.com',
    'May this be a space that helps with your continuous growth.',
  ]);

  const htmlBody = renderEmail({
    preheader: 'Your Hilom Learning Hub account is ready — set a password to sign in.',
    heading: `Welcome to Hilom Collective, ${firstname}`,
    body:
      p('Your Hilom Learning Hub account has been created.') +
      details([{ label: 'Username', value: escapeHtml(email) }]) +
      // The account is admin-created and genuinely has no password yet, so the
      // "Forgot your password?" route is the real path to setting one — not
      // the workaround it looks like. Spelled out step by step because a
      // welcome email telling someone to use password *recovery* is confusing
      // enough to lose people at the first step.
      p('Your account does not have a password yet. To set one:') +
      p(
        '<strong>1.</strong> Open the sign-in page below.<br>' +
          '<strong>2.</strong> Click <em>Forgot your password?</em><br>' +
          `<strong>3.</strong> Enter <strong>${escapeHtml(email)}</strong> as the username.<br>` +
          '<strong>4.</strong> Follow the emailed instructions to create your password.',
      ) +
      button('Go to the sign-in page', LOGIN_URL) +
      note("Once you're signed in, your learning dashboard and courses are all in one place.") +
      note(
        'Need a hand? Email us at ' +
          link('kumusta@hilomcollective.com', 'mailto:kumusta@hilomcollective.com') +
          '. May this be a space that helps with your continuous growth.',
      ),
  });

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: 'Welcome to Hilom Collective — your account is ready' },
          Body: {
            Text: { Data: textBody },
            Html: { Data: htmlBody },
          },
        },
      },
    }),
  );
}

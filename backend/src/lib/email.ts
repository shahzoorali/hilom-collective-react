/**
 * Transactional account emails, sent via SES instead of Cognito's built-in
 * (sandboxed, `no-reply@verificationemail.com`-branded) email sending.
 *
 * SES sends from ap-south-1 (Mumbai), not this stack's usual ap-southeast-1:
 * hilomcollective.com is already a verified, DKIM-signed domain identity
 * there with production access — see community.ts for the same pattern.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <noreply@hilomcollective.com>';

/** Hosted UI's own sign-in page, which has a built-in "Forgot your password?" link. */
const LOGIN_URL =
  'https://hilom-auth.auth.ap-southeast-1.amazoncognito.com/login' +
  '?client_id=29bo0gpj7j9u7ofbcii22emj8l&response_type=code&scope=openid+email+profile' +
  '&redirect_uri=https%3A%2F%2Fhilomcollective.com%2Fauth%2Fcallback';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sent once, right after a buyer's Cognito account is first admin-created.
 * Cognito's own welcome email is suppressed (MessageAction: 'SUPPRESS' in
 * ensureCognitoUser) in favor of this — the account has no password yet, so
 * the buyer is walked through Hosted UI's "Forgot your password?" flow to
 * set their own, rather than being handed a Cognito temporary password.
 */
export async function sendAccountCreatedEmail(email: string, firstname: string): Promise<void> {
  const textBody = [
    `Hi ${firstname},`,
    '',
    'Welcome to Hilom Collective! 🌿',
    '',
    'Your Hilom Learning Hub account has been created.',
    '',
    `Username: ${email}`,
    '',
    'To set your own password, go to the login page using the link below:',
    '',
    LOGIN_URL,
    '',
    "Once you're on the login page:",
    '',
    '1. Click "Forgot your password?"',
    '2. Enter the username provided above.',
    '3. Follow the instructions sent to your email to create your password.',
    '4. Return to the login page and sign in.',
    '',
    "Once you're logged in, you'll be able to access your learning dashboard and courses.",
    '',
    'If you need any help, please contact us at kumusta@hilomcollective.com',
    '',
    'May this be a space help with your continuous growth.',
  ].join('\n');

  const htmlBody = `
    <p>Hi ${escapeHtml(firstname)},</p>
    <p>Welcome to Hilom Collective! 🌿</p>
    <p>Your Hilom Learning Hub account has been created.</p>
    <p><strong>Username:</strong> ${escapeHtml(email)}</p>
    <p>To set your own password, go to the login page using the link below:</p>
    <p><a href="${LOGIN_URL}">${LOGIN_URL}</a></p>
    <p>Once you're on the login page:</p>
    <ol>
      <li>Click <em>Forgot your password?</em></li>
      <li>Enter the username provided above.</li>
      <li>Follow the instructions sent to your email to create your password.</li>
      <li>Return to the login page and sign in.</li>
    </ol>
    <p>Once you're logged in, you'll be able to access your learning dashboard and courses.</p>
    <p>If you need any help, please contact us at <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a></p>
    <p>May this be a space help with your continuous growth.</p>
  `;

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

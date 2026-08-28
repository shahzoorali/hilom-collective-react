/**
 * Cognito CustomEmailSender trigger — sends every Cognito-originated email
 * (sign-up code, resend, forgotten-password code, attribute verification)
 * ourselves via SES instead of Cognito's built-in sender.
 *
 * ## Why this exists
 *
 * Cognito's built-in email is either its own sandboxed sender
 * (`no-reply@verificationemail.com`, ~50/day, frequently spam-filed) or an
 * SES identity — but the SES `SourceArn` a user pool will accept is
 * restricted to a fixed region list (eu-west-1, ap-southeast-1, us-east-1,
 * us-west-2 for this pool). The only SES region with production access here
 * is ap-south-1, which is not on that list. CustomEmailSender sidesteps the
 * restriction entirely: Cognito hands us the code and we send it however we
 * like — here, the same ap-south-1 SES identity every other transactional
 * email already uses (see `email.ts`).
 *
 * ## The one rule
 *
 * Once this trigger is configured, Cognito sends **none** of its own emails.
 * Every `request.type` that can occur must be handled here or that flow goes
 * silently dark. The switch below is exhaustive over the documented types;
 * the `default` logs loudly rather than failing closed on an unknown one.
 *
 * The code arrives encrypted with the pool's KMS key and is decrypted with
 * the AWS Encryption SDK (`@aws-crypto/client-node`), the format Cognito
 * emits — a plain `kms:Decrypt` will not read it.
 */
import { buildClient, CommitmentPolicy, KmsKeyringNode } from '@aws-crypto/client-node';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { CustomEmailSenderTriggerEvent } from 'aws-lambda';
import { renderEmail, renderText, note, p } from '../lib/email-layout.js';

const sesClient = new SESv2Client({ region: 'ap-south-1' });

const SENDER = 'Hilom Collective <noreply@hilomcollective.com>';
const REPLY_TO = 'kumusta@hilomcollective.com';

const KEY_ARN = process.env.COGNITO_CUSTOM_EMAIL_KEY_ARN;

const { decrypt } = buildClient(CommitmentPolicy.FORBID_ENCRYPT_ALLOW_DECRYPT);
// Lazily built so a missing env var surfaces as a clear error, not a
// module-load crash with no context.
let keyring: KmsKeyringNode | undefined;

async function decryptCode(encrypted: string): Promise<string> {
  if (!KEY_ARN) throw new Error('COGNITO_CUSTOM_EMAIL_KEY_ARN is not set');
  if (!keyring) keyring = new KmsKeyringNode({ keyIds: [KEY_ARN] });
  const { plaintext } = await decrypt(keyring, Buffer.from(encrypted, 'base64'));
  return plaintext.toString('utf8');
}

/**
 * The code itself — big, spaced, monospace, on its own so it survives a
 * glance and a copy-paste. Not in `email-layout.ts` because a one-time code
 * is unique to this sender.
 */
function codeBlock(code: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
    <tr><td align="center" bgcolor="#fffdf8" style="padding:20px;border:1px solid #e7e0cc;border-radius:8px;">
      <span style="font-family:'Courier New',Courier,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#244a31;">${escapeCode(code)}</span>
    </td></tr>
  </table>`;
}

/** Codes are `[0-9A-Za-z]` from Cognito, but never trust that into markup. */
function escapeCode(code: string): string {
  return code.replace(/[^0-9A-Za-z-]/g, '');
}

interface Mail {
  subject: string;
  heading: string;
  intro: string;
  expiry: string;
}

function mailFor(type: string): Mail | null {
  switch (type) {
    case 'CustomEmailSender_SignUp':
    case 'CustomEmailSender_ResendCode':
      return {
        subject: 'Confirm your email address',
        heading: 'Confirm your email address',
        intro:
          'Enter this code to confirm your email and finish setting up your Hilom Collective account:',
        expiry:
          "This code expires in 24 hours. If you didn't create an account, you can safely ignore this email.",
      };
    case 'CustomEmailSender_ForgotPassword':
      return {
        subject: 'Reset your Hilom Collective password',
        heading: 'Reset your password',
        intro: 'Enter this code to reset your Hilom Collective password:',
        expiry:
          "This code expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.",
      };
    case 'CustomEmailSender_UpdateUserAttribute':
    case 'CustomEmailSender_VerifyUserAttribute':
      return {
        subject: 'Verify your email address',
        heading: 'Verify your email address',
        intro: 'Enter this code to verify this email address on your Hilom Collective account:',
        expiry:
          "This code expires in 24 hours. If you didn't request this change, please contact us.",
      };
    // Buyer accounts are admin-created with MessageAction 'SUPPRESS' and get
    // our own welcome email (see cognito.ts / email.ts), so this type should
    // not reach us — handled explicitly so it's a no-op, not a default.
    case 'CustomEmailSender_AdminCreateUser':
    case 'CustomEmailSender_AccountTakeOverNotification':
      return null;
    default:
      return null;
  }
}

export async function handler(event: CustomEmailSenderTriggerEvent): Promise<void> {
  // The flow is on `triggerSource` (`CustomEmailSender_SignUp`, …).
  // `request.type` is always the literal `customEmailSenderRequestV1` and
  // says nothing about which email to send.
  const type = event.triggerSource;
  const { code } = event.request;
  // The union widens `userAttributes` per trigger type; every variant that
  // carries a code also carries `email`, so read it through a flat view.
  const email = (event.request.userAttributes as Record<string, string | undefined>).email;

  const mail = mailFor(type);
  if (!mail) {
    console.warn('[cognito-custom-email] no template for trigger type; nothing sent', { type });
    return;
  }
  if (!code) {
    console.error('[cognito-custom-email] trigger carried no code', { type });
    return;
  }
  if (!email) {
    console.error('[cognito-custom-email] user has no email attribute', { type });
    return;
  }

  const plainCode = await decryptCode(code);

  const htmlBody = renderEmail({
    preheader: `${mail.heading} — your code is ${escapeCode(plainCode)}`,
    heading: mail.heading,
    body: p(mail.intro) + codeBlock(plainCode) + note(mail.expiry),
  });
  const textBody = renderText(mail.heading, [
    mail.intro,
    '',
    `    ${escapeCode(plainCode)}`,
    '',
    mail.expiry,
  ]);

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [email] },
      ReplyToAddresses: [REPLY_TO],
      Content: {
        Simple: {
          Subject: { Data: mail.subject },
          Body: { Text: { Data: textBody }, Html: { Data: htmlBody } },
        },
      },
    }),
  );

  console.log('[cognito-custom-email] sent', { type, email });
}

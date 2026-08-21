/**
 * Sends the "your course is ready" email once fulfillment succeeds.
 *
 * Before this, a buyer's only confirmation was PayMongo's own payment receipt
 * and — on the fallback account-creation path — Cognito's raw "temporary
 * password" email. Neither says anything about Hilom, and neither survives the
 * buyer closing the processing tab before it flips to "fulfilled". This is the
 * safety net for that: sent from the same place fulfillment succeeds, not from
 * the browser, so it fires whether or not anyone is still watching the screen.
 *
 * SES sends from ap-south-1, the same identity `community.ts` already uses —
 * not the ap-southeast-1 identity verified 2026-08-21. A Lambda calling the SES
 * API has no region constraint tying it to its own region (community.ts already
 * proves that, sending ap-south-1 mail from an ap-southeast-1 function), so
 * there is no reason to route this through the newer identity, which is still
 * sandboxed. ap-south-1 already has production access — using it here means
 * this email works for real buyer addresses today, not once a separate SES
 * production-access request clears.
 *
 * The ap-southeast-1 identity still matters elsewhere: Cognito's own built-in
 * email sending (configured by scripts/configure-cognito-ses.ts) is genuinely
 * region-locked to the user pool's region, so that path has no choice but to
 * use it and will stay sandboxed until production access is granted there too.
 *
 * A failure here must never take down fulfillment: the buyer already has
 * working course access by the time this runs, and Moodle enrollment is the
 * part that actually matters. Errors are logged and swallowed.
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

export interface EnrollmentEmailInput {
  buyerEmail: string;
  productName: string;
  /** Where "Start learning" should send them — see accessUrl() in fulfillment.ts. */
  accessUrl: string;
}

/**
 * Best-effort — resolves on both success and failure. Callers should not
 * `await` this expecting a rejection to mean anything actionable; check logs
 * instead. (Not fire-and-forget, though: Lambda can freeze the execution
 * environment the instant the handler returns, so a truly unawaited send could
 * simply never happen.)
 */
export async function sendEnrollmentEmail(input: EnrollmentEmailInput): Promise<void> {
  const { buyerEmail, productName, accessUrl } = input;

  // "Choose Hilom Account" and the click-again note mirror Processing.tsx —
  // see the comment there for why (docs/sso-runbook.md's documented
  // first-attempt sesskey quirk). This email is the only place some buyers
  // ever see that guidance, since not everyone waits on the processing screen.
  const textBody = [
    `Your course is ready: ${productName}`,
    '',
    `Sign in at ${accessUrl} with this email address (${buyerEmail}) to start.`,
    `On the sign-in page, choose "Hilom Account". First time signing in may bounce you back`,
    `once — if that happens, just click "Hilom Account" again.`,
    '',
    'This access is permanent — no expiry, no subscription.',
    '',
    "If you didn't expect this email, reply and let us know.",
  ].join('\n');

  const htmlBody = `
    <p><strong>Your course is ready:</strong> ${escapeHtml(productName)}</p>
    <p><a href="${accessUrl}">Start learning</a> — sign in with <strong>${escapeHtml(buyerEmail)}</strong>.</p>
    <p style="color:#666;font-size:14px;">
      On the sign-in page, choose <strong>Hilom Account</strong>. First time signing in may bounce
      you back once — if that happens, just click <strong>Hilom Account</strong> again.
    </p>
    <p style="color:#666;font-size:14px;">This access is permanent — no expiry, no subscription.</p>
    <p style="color:#666;font-size:14px;">If you didn't expect this email, reply and let us know.</p>
  `;

  try {
    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [buyerEmail] },
        Content: {
          Simple: {
            Subject: { Data: `Your course is ready: ${productName}` },
            Body: {
              Text: { Data: textBody },
              Html: { Data: htmlBody },
            },
          },
        },
      }),
    );
  } catch (err) {
    console.warn('[enrollment-email] send failed — enrollment itself is unaffected', {
      buyerEmail,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

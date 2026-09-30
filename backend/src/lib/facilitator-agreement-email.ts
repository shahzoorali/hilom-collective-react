/**
 * Emails the fully-signed agreement to the facilitator, PDF attached.
 *
 * Sent once both signatures are on the record (the moment of countersignature),
 * so the copy in their inbox is the executed one. Failure is logged and
 * swallowed: the signature is already committed, the facilitator can download
 * the same PDF from their dashboard, and an SES hiccup must never undo or
 * block an approval.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { renderEmail, renderText, p, note, button } from './email-layout.js';
import { buildRawEmail } from './mime.js';
import {
  agreementPdfFilename,
  buildAgreementPdf,
  type AgreementAcceptance,
  type AgreementVersion,
} from './facilitator-agreement.js';

// Same verified SES identity and region as every other sender here.
const sesClient = new SESv2Client({ region: 'ap-south-1' });
const SENDER = 'Hilom Collective <kumusta@hilomcollective.com>';
const DASHBOARD = 'https://www.hilomcollective.com/facilitator';

export async function sendSignedAgreementCopy(
  to: string,
  displayName: string,
  version: AgreementVersion,
  acceptance: AgreementAcceptance,
): Promise<void> {
  try {
    const pdf = await buildAgreementPdf(version, acceptance);
    const subject = 'Your signed Hilom Facilitator Partnership Agreement';

    const html = renderEmail({
      preheader: 'Your copy of the signed agreement is attached.',
      heading: `Your agreement is signed, ${displayName}`,
      body:
        p('Both you and Hilom Collective have now signed the Facilitator Partnership Agreement. Your copy is attached to this email.') +
        p('You can download it again at any time from your dashboard.') +
        button('Open your dashboard', DASHBOARD) +
        note('Keep this email for your records.'),
    });
    const text = renderText(`Your agreement is signed, ${displayName}.`, [
      'Both you and Hilom Collective have now signed the Facilitator Partnership Agreement.',
      'Your copy is attached to this email.',
      '',
      `You can download it again any time from your dashboard: ${DASHBOARD}`,
    ]);

    await sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: SENDER,
        Destination: { ToAddresses: [to] },
        Content: {
          Raw: {
            Data: buildRawEmail({
              from: SENDER,
              to,
              subject,
              text,
              html,
              attachments: [
                {
                  filename: agreementPdfFilename(acceptance),
                  contentType: 'application/pdf',
                  content: pdf,
                },
              ],
            }),
          },
        },
      }),
    );
  } catch (err) {
    console.warn('[facilitator-agreement-email] send failed — the signature itself is unaffected', {
      to,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

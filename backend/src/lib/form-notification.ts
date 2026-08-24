/**
 * Builds the team-notification email for a CMS form submission.
 *
 * Split out from handlers/forms.ts so the shaping logic — which field goes
 * where, what an empty checkbox group reads as, which field becomes the
 * reply-to address — can be pinned by a test without mocking SES. The actual
 * send stays in the handler; this returns content only.
 */
import type { FormField } from './cms-blocks.js';
import { renderEmail, renderText, escapeHtml, note, details } from './email-layout.js';

export interface FormNotificationEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  /** Set only when the form actually collected an email field. */
  replyTo: string;
}

/** Renders one collected field value for the notification email. */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none selected)';
  const str = typeof value === 'string' ? value.trim() : '';
  return str || '(blank)';
}

/**
 * Rendered from the field definitions rather than raw `data` keys, so the
 * order and labels match what the submitter actually saw on the page.
 */
export function buildFormNotificationEmail(
  formName: string,
  fields: FormField[],
  data: Record<string, unknown>,
): FormNotificationEmail {
  const rows = fields.map((field) => ({ label: field.label, value: formatValue(data[field.name]) }));
  const emailField = fields.find((f) => f.type === 'email');
  const replyTo = emailField ? String(data[emailField.name] ?? '').trim() : '';
  const subject = `New submission: ${formName}`;

  const textBody = renderText(subject, [
    // Some admin-authored labels already end in a colon (the retreat waitlist's
    // "I'm interested in:" is live in production), so one is not appended
    // blindly — a field labelled that way must not read "in:: value".
    ...rows.map((r) => `${r.label.replace(/:\s*$/, '')}: ${r.value}`),
    '',
    'Reply to this email to reach them directly.',
  ]);

  const htmlBody = renderEmail({
    preheader: `New ${formName} submission`,
    heading: subject,
    body:
      details(rows.map((r) => ({ label: r.label, value: escapeHtml(r.value) }))) +
      (replyTo ? note('Reply to this email to reach them directly.') : ''),
  });

  return { subject, textBody, htmlBody, replyTo };
}

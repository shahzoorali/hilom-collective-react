/**
 * Tests for the CMS-form notification email content.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * This is the content-shaping half of wiring `notify_email` up to actually
 * send. The gap it closes: notify_email was a configurable column nobody read,
 * so a form like the retreat waitlist could collect real submissions with no
 * one at Hilom finding out. These tests pin what the resulting email says, not
 * that SES was called — the send itself is a single AWS SDK call in
 * handlers/forms.ts, and mocking that would test the SDK, not this code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormNotificationEmail } from './form-notification.js';
import type { FormField } from './cms-blocks.js';

const retreatFields: FormField[] = [
  { name: 'name', label: 'Name', type: 'text', required: true, half: true },
  { name: 'email', label: 'Email Address', type: 'email', required: true, half: true },
  {
    name: 'interested_in',
    label: "I'm interested in:",
    type: 'checkboxGroup',
    required: true,
    options: ['January 2027 Retreat', 'April 2027 Retreat'],
  },
  { name: 'message', label: 'Message', type: 'textarea', required: false },
];

describe('buildFormNotificationEmail', () => {
  it('names the form in the subject and heading', () => {
    const email = buildFormNotificationEmail('2027 Retreat Waitlist', retreatFields, {
      name: 'Maria',
      email: 'maria@example.com',
      interested_in: ['January 2027 Retreat'],
      message: '',
    });
    assert.equal(email.subject, 'New submission: 2027 Retreat Waitlist');
    assert.match(email.htmlBody, /New submission: 2027 Retreat Waitlist/);
  });

  it('lists every field by its label, in field order, not the raw data keys', () => {
    const email = buildFormNotificationEmail('2027 Retreat Waitlist', retreatFields, {
      name: 'Maria',
      email: 'maria@example.com',
      interested_in: ['January 2027 Retreat', 'April 2027 Retreat'],
      message: 'Excited!',
    });
    assert.match(email.textBody, /Name: Maria/);
    assert.match(email.textBody, /Email Address: maria@example\.com/);
    assert.match(email.textBody, /I'm interested in: January 2027 Retreat, April 2027 Retreat/);
    assert.match(email.textBody, /Message: Excited!/);
    // Order matters for a reader scanning the email against the form.
    const order = ['Name:', 'Email Address:', "I'm interested in:", 'Message:'].map((l) =>
      email.textBody.indexOf(l),
    );
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
  });

  it('does not double a colon when the label already ends in one', () => {
    // Not a hypothetical: the live retreat-waitlist form's checkboxGroup label
    // is literally "I'm interested in:" (trailing colon included).
    const email = buildFormNotificationEmail('2027 Retreat Waitlist', retreatFields, {
      name: 'Maria',
      email: 'maria@example.com',
      interested_in: ['January 2027 Retreat'],
      message: '',
    });
    assert.doesNotMatch(email.textBody, /in::/);
    assert.match(email.textBody, /I'm interested in: January 2027 Retreat/);
  });

  it('renders an empty checkbox group and a blank optional field as placeholders, not nothing', () => {
    const email = buildFormNotificationEmail('2027 Retreat Waitlist', retreatFields, {
      name: 'Maria',
      email: 'maria@example.com',
      interested_in: [],
      message: '',
    });
    assert.match(email.textBody, /I'm interested in: \(none selected\)/);
    assert.match(email.textBody, /Message: \(blank\)/);
  });

  it('sets replyTo from the form\'s email field, so the team can just hit reply', () => {
    const email = buildFormNotificationEmail('2027 Retreat Waitlist', retreatFields, {
      name: 'Maria',
      email: 'maria@example.com',
      interested_in: [],
      message: '',
    });
    assert.equal(email.replyTo, 'maria@example.com');
  });

  it('leaves replyTo blank for a form with no email field, rather than guessing', () => {
    const noEmailFields: FormField[] = [{ name: 'name', label: 'Name', type: 'text', required: true }];
    const email = buildFormNotificationEmail('Some Form', noEmailFields, { name: 'Maria' });
    assert.equal(email.replyTo, '');
    // The "reply to this email" line would be misleading with no reply-to set.
    assert.doesNotMatch(email.htmlBody, /Reply to this email/);
  });

  it('escapes HTML in a field value so a submission cannot inject markup into the notification', () => {
    const fields: FormField[] = [{ name: 'name', label: 'Name', type: 'text', required: true }];
    const email = buildFormNotificationEmail('Some Form', fields, {
      name: '<img src=x onerror=alert(1)>',
    });
    // The submitted value must appear only in its escaped form. The template
    // itself legitimately contains an unrelated <img> tag for the logo, so the
    // assertion targets the specific injected payload rather than any <img.
    assert.doesNotMatch(email.htmlBody, /<img src=x onerror/);
    assert.match(email.htmlBody, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

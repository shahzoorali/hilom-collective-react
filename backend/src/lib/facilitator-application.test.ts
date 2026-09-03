/**
 * Tests for the facilitator application form's server-side validation.
 *
 * Same setup as the sibling test files: `node:test` via tsx, no framework.
 *
 * Three groups of cases matter here, and they are not "does this reject a bad
 * string":
 *
 *  * **Consent.** It has to be impossible to submit an application without it,
 *    from any client, because the row is the only evidence it was ever given.
 *  * **The `not_sure` / support-track interaction.** The form asks "what kind
 *    of support do you need?" and also offers "I'm not sure — recommend
 *    something". If the first were required, the second would be a dead end.
 *    That pairing is easy to "tidy up" later into a required field, and this
 *    is what catches it.
 *  * **Privilege.** An applicant must never be able to set their own status or
 *    fee rate by putting one in the body.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateApplication, FacilitatorInputError } from './facilitator-input.js';

/** The minimum a valid application carries. */
const base = {
  display_name: 'Elaine Estrella',
  contact_method: 'email',
  years_experience: '5_plus',
  program_status: ['existing_program_online'],
  referral_source: 'friend_colleague',
  privacy_accepted: true,
};

const rejects = (body: Record<string, unknown>, pattern: RegExp) =>
  assert.throws(
    () => validateApplication(body),
    (err: unknown) => err instanceof FacilitatorInputError && pattern.test((err as Error).message),
  );

describe('validateApplication — consent', () => {
  it('accepts an application that agreed to the privacy policy', () => {
    const a = validateApplication(base);
    assert.ok(a.privacy_accepted_at, 'the acceptance must be timestamped');
    assert.ok(a.privacy_policy_version, 'and pinned to a policy version');
  });

  it('refuses an application with no consent at all', () => {
    const { privacy_accepted, ...withoutConsent } = base;
    void privacy_accepted;
    rejects(withoutConsent, /privacy policy/i);
  });

  it('refuses a merely truthy consent value', () => {
    // A client sending "true" or 1 has not been through the checkbox; the
    // check is strict so that only a real boolean counts.
    rejects({ ...base, privacy_accepted: 'true' }, /privacy policy/i);
    rejects({ ...base, privacy_accepted: 1 }, /privacy policy/i);
  });

  it('stamps the timestamp server-side, ignoring anything the client sends', () => {
    const a = validateApplication({
      ...base,
      privacy_accepted_at: '1999-01-01T00:00:00.000Z',
      privacy_policy_version: 'whatever-they-like',
    });
    assert.notEqual(a.privacy_accepted_at, '1999-01-01T00:00:00.000Z');
    assert.notEqual(a.privacy_policy_version, 'whatever-they-like');
  });
});

describe('validateApplication — support tracks and program status', () => {
  it('accepts multiple support tracks', () => {
    const a = validateApplication({
      ...base,
      support_needed: ['build_launch', 'live_experiences'],
    });
    assert.deepEqual(a.support_needed, ['build_launch', 'live_experiences']);
  });

  it('accepts no support track at all', () => {
    // The paired half of `not_sure` below. Zero tracks is a real answer, not a
    // missing field — see the note on the column in 0023_facilitator_intake.sql.
    assert.deepEqual(validateApplication(base).support_needed, []);
  });

  it('lets someone say they are not sure without also naming a track', () => {
    const a = validateApplication({
      ...base,
      program_status: ['not_sure'],
      support_needed: [],
    });
    assert.deepEqual(a.program_status, ['not_sure']);
    assert.deepEqual(a.support_needed, []);
  });

  it('requires at least one answer about where they are now', () => {
    rejects({ ...base, program_status: [] }, /what you have/i);
  });

  it('rejects an option that is not on the form', () => {
    rejects({ ...base, support_needed: ['ghostwriting'] }, /unrecognised option/i);
    rejects({ ...base, program_status: ['world_domination'] }, /unrecognised option/i);
  });

  it('de-duplicates a repeated selection', () => {
    const a = validateApplication({ ...base, support_needed: ['design', 'design'] });
    assert.deepEqual(a.support_needed, ['design']);
  });
});

describe('validateApplication — contact details', () => {
  it('requires a phone number when they asked to be phoned', () => {
    rejects({ ...base, contact_method: 'phone' }, /phone number is required/i);
    rejects({ ...base, contact_method: 'whatsapp' }, /phone number is required/i);
  });

  it('does not require one when they chose email', () => {
    assert.equal(validateApplication(base).phone, null);
  });

  it('requires a handle when they asked to be reached on Instagram', () => {
    rejects({ ...base, contact_method: 'instagram' }, /instagram handle is required/i);
  });

  it('rejects a contact method that is not offered', () => {
    rejects({ ...base, contact_method: 'carrier_pigeon' }, /not a valid option/i);
  });
});

describe('validateApplication — links people actually type', () => {
  it('accepts a scheme-less URL, which is what the first real applicant sent', () => {
    const a = validateApplication({ ...base, social_handle: 'www.instagram.com/holdingspace.ph' });
    assert.equal(a.social_links.social, 'https://www.instagram.com/holdingspace.ph');
  });

  it('keeps a bare @handle as written', () => {
    const a = validateApplication({ ...base, social_handle: '@holdingspace.ph' });
    assert.equal(a.social_links.social, '@holdingspace.ph');
  });

  it('accepts a full URL unchanged', () => {
    const a = validateApplication({ ...base, website_url: 'https://holdingspace.ph/home/' });
    assert.equal(a.website_url, 'https://holdingspace.ph/home/');
  });

  it('refuses a javascript: URI dressed up as a link', () => {
    rejects({ ...base, website_url: 'javascript:alert(1)' }, /http or https/i);
  });
});

describe('validateApplication — referral source', () => {
  it('requires the free-text box when "Other" is chosen', () => {
    rejects({ ...base, referral_source: 'other' }, /how you heard/i);
  });

  it('keeps the free text when "Other" is chosen', () => {
    const a = validateApplication({
      ...base,
      referral_source: 'other',
      referral_source_other: 'Veronica Lu',
    });
    assert.equal(a.referral_source_other, 'Veronica Lu');
  });

  it('drops stray free text when a listed option is chosen', () => {
    // Otherwise the two columns disagree, and a report grouping by
    // referral_source would show a count that the detail row contradicts.
    const a = validateApplication({
      ...base,
      referral_source: 'instagram',
      referral_source_other: 'leftover from switching the select',
    });
    assert.equal(a.referral_source_other, null);
  });
});

describe('validateApplication — what an applicant may not set', () => {
  it('ignores a status in the body', () => {
    const a = validateApplication({ ...base, status: 'published' }) as Record<string, unknown>;
    assert.equal(a.status, undefined, 'an applicant must not be able to publish themselves');
  });

  it('ignores a platform fee in the body', () => {
    const a = validateApplication({ ...base, platform_fee_bps: 0 }) as Record<string, unknown>;
    assert.equal(a.platform_fee_bps, undefined, 'an applicant must not set their own commission');
  });

  it('ignores an email in the body — the token owns that', () => {
    const a = validateApplication({ ...base, email: 'someone@else.test' }) as Record<string, unknown>;
    assert.equal(a.email, undefined);
  });

  it('refuses a certificate key pointing outside the private prefix', () => {
    rejects({ ...base, cert_document_key: 'media/2026/09/someone-elses.pdf' }, /not valid/i);
    rejects({ ...base, cert_document_key: 'facilitator-docs/../media/x.pdf' }, /not valid/i);
  });

  it('accepts a certificate key inside it', () => {
    const key = 'facilitator-docs/sub-123/abc-cert.pdf';
    assert.equal(validateApplication({ ...base, cert_document_key: key }).cert_document_key, key);
  });
});

describe('validateApplication — the profile fields it no longer collects', () => {
  it('does not accept credentials, specialties or scope of practice', () => {
    // These moved to the dashboard Profile tab. If they ever come back to this
    // form, that is a decision worth making on purpose rather than by a body
    // field quietly starting to land again.
    const a = validateApplication({
      ...base,
      credentials: ['MA Counselling Psychology'],
      specialties: ['Nervous system regulation'],
      scope_note: 'I am not a licensed therapist.',
    }) as Record<string, unknown>;

    assert.equal(a.credentials, undefined);
    assert.equal(a.specialties, undefined);
    assert.equal(a.scope_note, undefined);
  });
});

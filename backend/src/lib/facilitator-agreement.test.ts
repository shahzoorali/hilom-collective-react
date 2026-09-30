import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgreementPdf,
  agreementPdfFilename,
  fieldsFor,
  formatAgreementDate,
  renderAgreement,
  sha256Hex,
  validateSignature,
  type AgreementAcceptance,
  type AgreementVersion,
} from './facilitator-agreement.js';
import { FacilitatorInputError } from './facilitator-input.js';

const version: AgreementVersion = {
  version: '2026-10-01',
  title: 'Facilitator Partnership Agreement',
  body_md:
    '# Facilitator Partnership Agreement\n\n' +
    'Entered into as of {{effective_date}} by HILOM COLLECTIVE, represented by {{hilom_signatory}}, of {{hilom_address}}, ' +
    'and {{facilitator_name}}, of {{facilitator_address}}, contact {{facilitator_contact}}.\n\n' +
    '## 1. FEES\n\nFees are ₱1,000 — “as agreed”. Ñandú’s café.\n\n- one\n\n- two\n',
  hilom_signatory: 'Rina Cruz',
  hilom_address: 'Makati City',
  status: 'current',
  published_at: '2026-10-01T00:00:00Z',
  created_by: 'test',
  created_at: '2026-10-01T00:00:00Z',
};

const acceptance: AgreementAcceptance = {
  id: '11111111-1111-1111-1111-111111111111',
  facilitator_id: '22222222-2222-2222-2222-222222222222',
  agreement_version: version.version,
  body_sha256: sha256Hex(version.body_md),
  signer_name: 'Maria Santos',
  signer_address: '1 Rizal St, Quezon City',
  signer_contact: 'maria@example.com',
  signed_at: '2026-10-02T03:00:00Z',
  signer_ip: '203.0.113.9',
  signer_user_agent: 'test',
  signer_cognito_sub: 'sub',
  countersigned_at: '2026-10-03T03:00:00Z',
  countersigned_by: 'admin (Hilom Collective)',
};

test('renderAgreement fills every placeholder', () => {
  const out = renderAgreement(version.body_md, fieldsFor(version, acceptance));
  assert.match(out, /as of 3 October 2026 by HILOM COLLECTIVE, represented by Rina Cruz, of Makati City/);
  assert.match(out, /Maria Santos, of 1 Rizal St, Quezon City, contact maria@example.com/);
  assert.doesNotMatch(out, /\{\{/);
});

test('renderAgreement shows readable fallbacks before signing, and leaves unknown placeholders visible', () => {
  const out = renderAgreement('{{effective_date}} / {{facilitator_name}} / {{typo_field}}', fieldsFor(version, null));
  assert.match(out, /countersignature/);
  assert.match(out, /your full legal name/);
  assert.match(out, /\{\{typo_field\}\}/);
});

test('formatAgreementDate uses Manila time', () => {
  // 17:00 UTC on the 30th is already the 1st in Manila.
  assert.equal(formatAgreementDate('2026-09-30T17:00:00Z'), '1 October 2026');
  assert.equal(formatAgreementDate(null), null);
});

test('the fingerprint changes when a single character does', () => {
  assert.notEqual(sha256Hex('Fee is 1,000'), sha256Hex('Fee is 1,001'));
  assert.equal(sha256Hex('same'), sha256Hex('same'));
});

test('validateSignature requires the acknowledgement, a full name, address and contact', () => {
  const good = {
    agreement_accepted: true,
    agreement_version: '2026-10-01',
    signer_name: '  Maria   Santos ',
    signer_address: '1 Rizal St',
    signer_contact: '0917 000 0000',
  };
  assert.equal(validateSignature(good).signer_name, 'Maria Santos');
  assert.throws(() => validateSignature({ ...good, agreement_accepted: 'true' }), FacilitatorInputError);
  assert.throws(() => validateSignature({ ...good, agreement_accepted: false }), FacilitatorInputError);
  assert.throws(() => validateSignature({ ...good, signer_name: 'Maria' }), /full legal name/);
  assert.throws(() => validateSignature({ ...good, signer_address: ' ' }), FacilitatorInputError);
  assert.throws(() => validateSignature({ ...good, signer_contact: '' }), FacilitatorInputError);
  assert.throws(() => validateSignature({ ...good, agreement_version: undefined }), FacilitatorInputError);
});

test('buildAgreementPdf renders a real PDF, including characters outside WinAnsi', async () => {
  const pdf = await buildAgreementPdf(version, acceptance);
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString('latin1'), '%PDF-');
  assert.ok(pdf.length > 1500);
});

test('buildAgreementPdf handles a not-yet-countersigned record and a very long agreement', async () => {
  const long = { ...version, body_md: version.body_md + '\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(3000) };
  const pdf = await buildAgreementPdf(long, { ...acceptance, countersigned_at: null, countersigned_by: null });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString('latin1'), '%PDF-');
});

test('agreementPdfFilename is ASCII-safe', () => {
  assert.equal(
    agreementPdfFilename({ ...acceptance, signer_name: 'María Ñandú' }),
    'Hilom Facilitator Agreement - Maria-Nandu.pdf',
  );
  assert.match(agreementPdfFilename({ ...acceptance, signer_name: '日本語' }), /signed\.pdf$/);
});

/**
 * The digital facilitator partnership agreement (migration 0066).
 *
 * Three ideas hold this together:
 *
 *  1. **The text is data, versioned.** A version is a draft until an admin
 *     publishes it; publishing freezes the words (a DB trigger enforces it) and
 *     retires whichever version was current. Changing the contract means
 *     publishing a new version, and everybody is asked to sign that one.
 *
 *  2. **A signature is a row, not a checkbox.** It records the version, a
 *     SHA-256 of the exact text signed, the typed legal name, address and
 *     contact, and where it came from (IP, browser, Cognito account). Rows are
 *     append-only in the database.
 *
 *  3. **Hilom's counter-signature is approval.** The facilitator signs when
 *     they apply. Approving them is Hilom's act of signing, and stamps the same
 *     row. Someone already approved who signs later (a new version, or the
 *     first rollout) is counter-signed at the moment they sign, because Hilom's
 *     assent was given by publishing the version.
 *
 * Nothing is enforced until a version is `current`. That is the rollout switch:
 * with none published, `agreementState` reports `required: false` and every
 * caller behaves exactly as it did before this feature existed.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { FacilitatorInputError } from './facilitator-input.js';

export interface AgreementVersion {
  version: string;
  title: string;
  body_md: string;
  hilom_signatory: string | null;
  hilom_address: string | null;
  status: 'draft' | 'current' | 'retired';
  published_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AgreementAcceptance {
  id: string;
  facilitator_id: string;
  agreement_version: string;
  body_sha256: string;
  signer_name: string;
  signer_address: string;
  signer_contact: string;
  signed_at: string;
  signer_ip: string | null;
  signer_user_agent: string | null;
  signer_cognito_sub: string | null;
  countersigned_at: string | null;
  countersigned_by: string | null;
}

export const VERSION_COLUMNS =
  'version, title, body_md, hilom_signatory, hilom_address, status, published_at, created_by, created_at';
export const ACCEPTANCE_COLUMNS =
  'id, facilitator_id, agreement_version, body_sha256, signer_name, signer_address, signer_contact, signed_at, signer_ip, signer_user_agent, signer_cognito_sub, countersigned_at, countersigned_by';

/** Statuses in which Hilom's assent is already given. */
const ACTIVE_STATUSES = new Set(['approved', 'published']);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface AgreementFields {
  effective_date?: string | null;
  hilom_signatory?: string | null;
  hilom_address?: string | null;
  facilitator_name?: string | null;
  facilitator_address?: string | null;
  facilitator_contact?: string | null;
}

const PLACEHOLDER_FALLBACKS: Record<keyof AgreementFields, string> = {
  effective_date: "the date of Hilom Collective's countersignature",
  hilom_signatory: '[Hilom Collective authorized representative]',
  hilom_address: '[Hilom Collective address]',
  facilitator_name: '[your full legal name]',
  facilitator_address: '[your address]',
  facilitator_contact: '[your contact details]',
};

/**
 * Fills `{{placeholders}}`. An unknown placeholder is left as written so a typo
 * in a draft is visible to the admin previewing it rather than silently blank.
 */
export function renderAgreement(bodyMd: string, fields: AgreementFields): string {
  return bodyMd.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    if (!(key in PLACEHOLDER_FALLBACKS)) return whole;
    const value = fields[key as keyof AgreementFields];
    return value && value.trim() ? value.trim() : PLACEHOLDER_FALLBACKS[key as keyof AgreementFields];
  });
}

/** "30 September 2026", in Manila time — the contract is governed by PH law. */
export function formatAgreementDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Manila',
  });
}

/** Field values for an acceptance (or a not-yet-signed preview when null). */
export function fieldsFor(
  version: Pick<AgreementVersion, 'hilom_signatory' | 'hilom_address'>,
  acceptance: AgreementAcceptance | null,
): AgreementFields {
  return {
    effective_date: formatAgreementDate(acceptance?.countersigned_at),
    hilom_signatory: version.hilom_signatory,
    hilom_address: version.hilom_address,
    facilitator_name: acceptance?.signer_name,
    facilitator_address: acceptance?.signer_address,
    facilitator_contact: acceptance?.signer_contact,
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SignatureInput {
  agreement_version: string;
  signer_name: string;
  signer_address: string;
  signer_contact: string;
}

function required(value: unknown, label: string, max: number): string {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw new FacilitatorInputError(`${label} is required to sign the agreement`);
  if (s.length > max) throw new FacilitatorInputError(`${label} must be ${max} characters or fewer`);
  return s;
}

/**
 * Validates the signing step. `agreement_accepted` must be literally `true`:
 * like the privacy checkbox, the UI control is the affordance and this is the
 * enforcement.
 */
export function validateSignature(body: Record<string, unknown>): SignatureInput {
  if (body.agreement_accepted !== true) {
    throw new FacilitatorInputError('You must read and agree to the Facilitator Partnership Agreement');
  }
  const signerName = required(body.signer_name, 'Your full legal name', 160);
  if (signerName.length < 3 || !/\s/.test(signerName)) {
    throw new FacilitatorInputError('Type your full legal name (first and last) to sign');
  }
  return {
    agreement_version: required(body.agreement_version, 'Agreement version', 80),
    signer_name: signerName,
    signer_address: required(body.signer_address, 'Your address', 400),
    signer_contact: required(body.signer_contact, 'Your contact details', 200),
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export async function getCurrentVersion(supabase: SupabaseClient): Promise<AgreementVersion | null> {
  const { data, error } = await supabase
    .from('facilitator_agreement_versions')
    .select(VERSION_COLUMNS)
    .eq('status', 'current')
    .maybeSingle<AgreementVersion>();
  if (error) throw error;
  return data;
}

export async function getVersion(supabase: SupabaseClient, version: string): Promise<AgreementVersion | null> {
  const { data, error } = await supabase
    .from('facilitator_agreement_versions')
    .select(VERSION_COLUMNS)
    .eq('version', version)
    .maybeSingle<AgreementVersion>();
  if (error) throw error;
  return data;
}

export async function getAcceptance(
  supabase: SupabaseClient,
  facilitatorId: string,
  version: string,
): Promise<AgreementAcceptance | null> {
  const { data, error } = await supabase
    .from('facilitator_agreement_acceptances')
    .select(ACCEPTANCE_COLUMNS)
    .eq('facilitator_id', facilitatorId)
    .eq('agreement_version', version)
    .maybeSingle<AgreementAcceptance>();
  if (error) throw error;
  return data;
}

export interface AgreementState {
  /** A current version exists, so signing is being asked of people. */
  required: boolean;
  /** The current version, or null. */
  current: AgreementVersion | null;
  /** The facilitator's acceptance of the current version, or null. */
  acceptance: AgreementAcceptance | null;
  /** `required` and not yet signed: the state that blocks approval and the dashboard. */
  needsSignature: boolean;
}

export async function agreementState(
  supabase: SupabaseClient,
  facilitatorId: string,
): Promise<AgreementState> {
  const current = await getCurrentVersion(supabase);
  if (!current) return { required: false, current: null, acceptance: null, needsSignature: false };
  const acceptance = await getAcceptance(supabase, facilitatorId, current.version);
  return { required: true, current, acceptance, needsSignature: acceptance === null };
}

export interface SignerMeta {
  ip: string | null;
  userAgent: string | null;
  cognitoSub: string | null;
}

/**
 * Records a facilitator's signature. Idempotent: signing a version twice
 * returns the original row rather than a second one (the unique constraint
 * would refuse it anyway, and a double-clicked button should not read as an
 * error). If the facilitator is already approved or published, Hilom's
 * counter-signature is applied in the same call.
 */
export async function recordAcceptance(
  supabase: SupabaseClient,
  facilitator: { id: string; status: string },
  version: AgreementVersion,
  input: SignatureInput,
  meta: SignerMeta,
): Promise<AgreementAcceptance> {
  if (version.status !== 'current') {
    throw new FacilitatorInputError('That version of the agreement is no longer current — reload and review the latest');
  }
  const existing = await getAcceptance(supabase, facilitator.id, version.version);
  if (existing) return existing;

  const { data, error } = await supabase
    .from('facilitator_agreement_acceptances')
    .insert({
      facilitator_id: facilitator.id,
      agreement_version: version.version,
      body_sha256: sha256Hex(version.body_md),
      signer_name: input.signer_name,
      signer_address: input.signer_address,
      signer_contact: input.signer_contact,
      signer_ip: meta.ip,
      signer_user_agent: meta.userAgent?.slice(0, 500) ?? null,
      signer_cognito_sub: meta.cognitoSub,
    })
    .select(ACCEPTANCE_COLUMNS)
    .single<AgreementAcceptance>();
  if (error) throw error;

  if (ACTIVE_STATUSES.has(facilitator.status)) {
    return (await countersign(supabase, data.id, 'Hilom Collective (published agreement)')) ?? data;
  }
  return data;
}

/** Stamps Hilom's counter-signature. A no-op on a row that already has one. */
export async function countersign(
  supabase: SupabaseClient,
  acceptanceId: string,
  by: string,
): Promise<AgreementAcceptance | null> {
  const { data, error } = await supabase
    .from('facilitator_agreement_acceptances')
    .update({ countersigned_at: new Date().toISOString(), countersigned_by: by })
    .eq('id', acceptanceId)
    .is('countersigned_at', null)
    .select(ACCEPTANCE_COLUMNS)
    .maybeSingle<AgreementAcceptance>();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 4;

/**
 * The standard PDF fonts are WinAnsi-only. Anything they cannot encode would
 * throw mid-render, so map the characters that actually turn up in Philippine
 * contracts and names, and replace the rest.
 */
function winAnsiSafe(text: string): string {
  return text
    .replace(/₱/g, 'PHP ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...')
    .replace(/[•●]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x20-\x7E\xA1-\xFF]/g, '?');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * The signed copy: the agreement as it stood when signed, with the signer's
 * particulars filled in, followed by the signature record.
 *
 * Rendered on demand from the stored rows rather than stored as a file. The
 * inputs are immutable (frozen version text, append-only acceptance), so the
 * output is reproducible, and there is no second copy to drift or to protect.
 */
export async function buildAgreementPdf(
  version: AgreementVersion,
  acceptance: AgreementAcceptance,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.44);
  const maxWidth = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const block = (
    text: string,
    opts: { font?: PDFFont; size?: number; indent?: number; gapBefore?: number; gapAfter?: number; color?: ReturnType<typeof rgb> } = {},
  ) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? BODY_SIZE;
    const indent = opts.indent ?? 0;
    const lines = wrap(winAnsiSafe(text), font, size, maxWidth - indent);
    y -= opts.gapBefore ?? 0;
    for (const line of lines) {
      ensure(size + LINE_GAP);
      y -= size;
      if (line) page.drawText(line, { x: MARGIN + indent, y, size, font, color: opts.color ?? ink });
      y -= LINE_GAP;
    }
    y -= opts.gapAfter ?? 0;
  };

  const rendered = renderAgreement(version.body_md, fieldsFor(version, acceptance));

  for (const raw of rendered.split(/\n{2,}/)) {
    const para = raw.trim();
    if (!para) continue;
    if (para.startsWith('# ')) {
      block(para.slice(2), { font: bold, size: 18, gapAfter: 4 });
    } else if (para.startsWith('## ')) {
      block(para.slice(3), { font: bold, size: 12, gapBefore: 10, gapAfter: 2 });
    } else if (para.startsWith('### ')) {
      block(para.slice(4), { font: bold, size: BODY_SIZE, gapBefore: 4 });
    } else if (para.startsWith('- ')) {
      block(`-  ${para.slice(2)}`, { indent: 14, gapAfter: 2 });
    } else if (/^\*[^*].*\*$/.test(para)) {
      block(para.slice(1, -1), { font: oblique, color: muted, gapAfter: 6 });
    } else {
      block(para, { gapAfter: 6 });
    }
  }

  // Signature record.
  ensure(220);
  y -= 14;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.75,
    color: muted,
  });
  y -= 6;
  block('Electronic signature record', { font: bold, size: 12, gapBefore: 6, gapAfter: 4 });

  const stamp = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Manila', dateStyle: 'long', timeStyle: 'long' })
      : 'not yet countersigned';

  block('FACILITATOR', { font: bold, size: 9, color: muted, gapAfter: 1 });
  block(acceptance.signer_name, { font: oblique, size: 14, gapAfter: 2 });
  block(`Signed electronically on ${stamp(acceptance.signed_at)}`, { size: 9.5 });
  block(`Address: ${acceptance.signer_address}`, { size: 9.5 });
  block(`Contact: ${acceptance.signer_contact}`, { size: 9.5, gapAfter: 8 });

  block('HILOM COLLECTIVE', { font: bold, size: 9, color: muted, gapAfter: 1 });
  if (acceptance.countersigned_at) {
    block(version.hilom_signatory ?? 'Authorized Representative', { font: oblique, size: 14, gapAfter: 2 });
    block(`Countersigned electronically on ${stamp(acceptance.countersigned_at)}`, { size: 9.5, gapAfter: 8 });
  } else {
    block('Awaiting countersignature on approval of the Facilitator.', { size: 9.5, gapAfter: 8 });
  }

  block('Verification', { font: bold, size: 9, color: muted, gapAfter: 1 });
  block(`Agreement version: ${version.version}`, { size: 8.5, color: muted });
  block(`Text fingerprint (SHA-256): ${acceptance.body_sha256}`, { size: 8.5, color: muted });
  block(`Record ID: ${acceptance.id}`, { size: 8.5, color: muted });
  block(
    'This agreement was concluded by electronic signature, which the parties agree has the same legal effect as a handwritten signature (Republic Act No. 8792, the Electronic Commerce Act).',
    { size: 8.5, color: muted, gapBefore: 4 },
  );

  // Footer page numbers.
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(`${version.title} - ${acceptance.signer_name} - page ${i + 1} of ${pages.length}`.replace(/[^\x20-\x7E]/g, '?'), {
      x: MARGIN,
      y: 28,
      size: 8,
      font: regular,
      color: muted,
    });
  });

  return doc.save();
}

/** ASCII filename: it becomes a MIME/Content-Disposition param (see lib/mime.ts). */
export function agreementPdfFilename(acceptance: AgreementAcceptance): string {
  const slug = acceptance.signer_name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `Hilom Facilitator Agreement - ${slug || 'signed'}.pdf`;
}

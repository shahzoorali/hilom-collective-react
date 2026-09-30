/**
 * Client for the digital facilitator partnership agreement (migration 0066).
 *
 * The text arrives from the API with `{{placeholders}}`; `fillAgreement` fills
 * them for the live preview while someone types their details. The server does
 * its own rendering for the signed copy (the PDF and `rendered_md`), so this
 * function only ever affects what is on screen, never what is recorded.
 */
import { API_BASE } from '../config';
import { apiFetch } from './api';
import { idToken } from './auth';

function authHeaders(): Record<string, string> {
  const token = idToken();
  if (!token) throw new Error('Sign in to continue');
  return { Authorization: `Bearer ${token}` };
}

export interface AgreementVersionView {
  version: string;
  title: string;
  body_md: string;
  hilom_signatory: string | null;
  hilom_address: string | null;
}

export interface AgreementAcceptanceView {
  signer_name: string;
  signer_address: string;
  signer_contact: string;
  signed_at: string;
  countersigned_at: string | null;
}

export interface AgreementView {
  /** A version is published, so signing is being asked of people. */
  required: boolean;
  needs_signature: boolean;
  facilitator: { status: string } | null;
  version: AgreementVersionView | null;
  acceptance: AgreementAcceptanceView | null;
  rendered_md: string | null;
}

export interface SignatureFields {
  signer_name: string;
  signer_address: string;
  signer_contact: string;
}

export const getAgreement = () =>
  apiFetch<AgreementView>('/facilitators/agreement', { headers: authHeaders() });

export const signAgreement = (version: string, fields: SignatureFields) =>
  apiFetch<{ acceptance: AgreementAcceptanceView; rendered_md: string }>('/facilitators/agreement', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ agreement_accepted: true, agreement_version: version, ...fields }),
  });

/** The fields the apply request carries so signing and applying are one submit. */
export const signatureBody = (version: string, fields: SignatureFields) => ({
  agreement_accepted: true as const,
  agreement_version: version,
  ...fields,
});

/**
 * Fetches a PDF and hands it to the browser as a download. `fetch` rather than
 * a plain link because the endpoint needs the bearer header.
 */
export async function downloadPdf(path: string, headers: Record<string, string>, fallbackName: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not download (${res.status})`);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const downloadMyAgreement = () =>
  downloadPdf('/facilitators/agreement/pdf', authHeaders(), 'Hilom Facilitator Agreement.pdf');

const FALLBACKS: Record<string, string> = {
  effective_date: "the date of Hilom Collective's countersignature",
  hilom_signatory: '[Hilom Collective authorized representative]',
  hilom_address: '[Hilom Collective address]',
  facilitator_name: '[your full legal name]',
  facilitator_address: '[your address]',
  facilitator_contact: '[your contact details]',
};

/** Live preview only — mirrors backend `renderAgreement`. */
export function fillAgreement(
  bodyMd: string,
  values: Partial<Record<string, string | null | undefined>>,
): string {
  return bodyMd.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    if (!(key in FALLBACKS)) return whole;
    const v = values[key]?.trim();
    return v ? v : (FALLBACKS[key] as string);
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminAgreementVersion {
  version: string;
  title: string;
  body_md: string;
  hilom_signatory: string | null;
  hilom_address: string | null;
  status: 'draft' | 'current' | 'retired';
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  signed: number;
  countersigned: number;
}

export interface AdminAgreementAcceptance {
  id: string;
  agreement_version: string;
  signer_name: string;
  signer_address: string;
  signer_contact: string;
  signed_at: string;
  signer_ip: string | null;
  countersigned_at: string | null;
  countersigned_by: string | null;
  body_sha256: string;
}

export interface AdminAgreementFields {
  version?: string;
  title: string;
  body_md: string;
  hilom_signatory: string;
  hilom_address: string;
}

const adminHeaders = (adminKey: string) => ({ 'x-admin-key': adminKey });
const adminJson = (adminKey: string) => ({ ...adminHeaders(adminKey), 'Content-Type': 'application/json' });

export const adminListAgreementVersions = (adminKey: string) =>
  apiFetch<{ versions: AdminAgreementVersion[] }>('/admin/facilitator-agreements', {
    headers: adminHeaders(adminKey),
  }).then((r) => r.versions);

export const adminCreateAgreementVersion = (adminKey: string, body: AdminAgreementFields) =>
  apiFetch<{ version: AdminAgreementVersion }>('/admin/facilitator-agreements', {
    method: 'POST',
    headers: adminJson(adminKey),
    body: JSON.stringify(body),
  });

export const adminUpdateAgreementVersion = (adminKey: string, version: string, body: AdminAgreementFields) =>
  apiFetch<{ version: AdminAgreementVersion }>(`/admin/facilitator-agreements/${encodeURIComponent(version)}`, {
    method: 'PATCH',
    headers: adminJson(adminKey),
    body: JSON.stringify(body),
  });

export const adminPublishAgreementVersion = (adminKey: string, version: string) =>
  apiFetch<{ version: AdminAgreementVersion }>(`/admin/facilitator-agreements/${encodeURIComponent(version)}`, {
    method: 'PATCH',
    headers: adminJson(adminKey),
    body: JSON.stringify({ action: 'publish' }),
  });

export const adminDownloadAgreement = (adminKey: string, facilitatorId: string, version?: string) =>
  downloadPdf(
    `/admin/facilitators/${encodeURIComponent(facilitatorId)}/agreement${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    adminHeaders(adminKey),
    'Hilom Facilitator Agreement.pdf',
  );

/**
 * The agreement text and the signing controls.
 *
 * Two pieces:
 *   * `AgreementText` renders the small markdown subset the contract uses
 *     (`#`, `##`, `###`, `- `, `*italic*`, paragraphs) as real elements. Nothing
 *     is injected as HTML, so text an admin pastes can never carry markup into
 *     a facilitator's browser.
 *   * `AgreementSigner` is the controlled form: the scrollable contract with the
 *     signer's details filled in live, three fields, and the "I agree" box.
 *     The parent owns the state so the apply form can fold signing into its own
 *     single submit, while `AgreementGate` (below) gives an already-approved
 *     facilitator a standalone screen with its own button.
 */
import { useState, type FormEvent } from 'react';
import {
  fillAgreement,
  signAgreement,
  type AgreementAcceptanceView,
  type AgreementVersionView,
  type SignatureFields,
} from '../lib/facilitator-agreement';

export function AgreementText({ markdown }: { markdown: string }) {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className="agreement-doc">
      {blocks.map((b, i) => {
        if (b.startsWith('### ')) return <h5 key={i}>{b.slice(4)}</h5>;
        if (b.startsWith('## ')) return <h4 key={i}>{b.slice(3)}</h4>;
        if (b.startsWith('# ')) return <h3 key={i}>{b.slice(2)}</h3>;
        if (b.startsWith('- ')) {
          return (
            <ul key={i}>
              <li>{b.slice(2)}</li>
            </ul>
          );
        }
        if (/^\*[^*].*\*$/.test(b)) {
          return (
            <p key={i} className="muted">
              <em>{b.slice(1, -1)}</em>
            </p>
          );
        }
        return <p key={i}>{b}</p>;
      })}
    </div>
  );
}

export const EMPTY_SIGNATURE: SignatureFields = { signer_name: '', signer_address: '', signer_contact: '' };

/** True when every field is filled and the signer has agreed. */
export function signatureComplete(fields: SignatureFields, agreed: boolean): boolean {
  return (
    agreed &&
    fields.signer_name.trim().split(/\s+/).length >= 2 &&
    fields.signer_address.trim().length > 0 &&
    fields.signer_contact.trim().length > 0
  );
}

export function AgreementSigner({
  version,
  fields,
  onFields,
  agreed,
  onAgreed,
}: {
  version: AgreementVersionView;
  fields: SignatureFields;
  onFields: (next: SignatureFields) => void;
  agreed: boolean;
  onAgreed: (next: boolean) => void;
}) {
  const filled = fillAgreement(version.body_md, {
    hilom_signatory: version.hilom_signatory,
    hilom_address: version.hilom_address,
    facilitator_name: fields.signer_name,
    facilitator_address: fields.signer_address,
    facilitator_contact: fields.signer_contact,
  });
  const set = (key: keyof SignatureFields) => (e: { target: { value: string } }) =>
    onFields({ ...fields, [key]: e.target.value });

  return (
    <fieldset className="agreement-signer">
      <legend>Facilitator Partnership Agreement</legend>
      <p className="small muted" style={{ marginTop: 0 }}>
        Please read the agreement below. You sign it electronically at the end of this form; Hilom
        countersigns when your application is approved, and you'll be emailed the signed copy.
      </p>

      <div className="agreement-scroll" tabIndex={0} aria-label="Agreement text">
        <AgreementText markdown={filled} />
      </div>

      <label className="field">
        <span>Your full legal name (this is your signature)</span>
        <input
          required
          value={fields.signer_name}
          onChange={set('signer_name')}
          autoComplete="name"
          placeholder="First and last name, as on your ID"
        />
      </label>
      <label className="field">
        <span>Your address</span>
        <input required value={fields.signer_address} onChange={set('signer_address')} autoComplete="street-address" />
      </label>
      <label className="field">
        <span>Contact details (phone or email for notices)</span>
        <input required value={fields.signer_contact} onChange={set('signer_contact')} />
      </label>

      <label className="field row" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
        <input type="checkbox" required checked={agreed} onChange={(e) => onAgreed(e.target.checked)} />
        <span>
          I have read and agree to the Facilitator Partnership Agreement, and I understand that typing
          my name above is my legally binding electronic signature.
        </span>
      </label>
    </fieldset>
  );
}

/**
 * The standalone screen: shown in place of the dashboard when a facilitator
 * (approved before agreements existed, or after a new version) has not signed
 * the current one.
 */
export function AgreementGate({
  version,
  defaultName,
  defaultContact,
  onSigned,
}: {
  version: AgreementVersionView;
  defaultName: string;
  defaultContact: string;
  onSigned: (acceptance: AgreementAcceptanceView) => void;
}) {
  const [fields, setFields] = useState<SignatureFields>({
    ...EMPTY_SIGNATURE,
    signer_name: defaultName,
    signer_contact: defaultContact,
  });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { acceptance } = await signAgreement(version.version, fields);
      onSigned(acceptance);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <AgreementSigner version={version} fields={fields} onFields={setFields} agreed={agreed} onAgreed={setAgreed} />
      {error && <div className="alert alert-error">{error}</div>}
      <button className="btn btn-accent btn-block" type="submit" disabled={busy || !signatureComplete(fields, agreed)}>
        {busy ? 'Signing…' : 'Sign the agreement'}
      </button>
    </form>
  );
}

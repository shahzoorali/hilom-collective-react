import { useEffect, useState } from 'react';
import {
  adminCreateAgreementVersion,
  adminListAgreementVersions,
  adminPublishAgreementVersion,
  adminUpdateAgreementVersion,
  fillAgreement,
  type AdminAgreementFields,
  type AdminAgreementVersion,
} from '../../lib/facilitator-agreement';
import { AgreementText } from '../../components/AgreementSigner';
import { adminConfirm, adminToast } from './ui/feedback';

/**
 * The facilitator partnership agreement: versions, drafting, publishing.
 *
 * A draft is editable; publishing freezes the words and makes it the version
 * every applicant signs. The previous current version is retired, and
 * facilitators who haven't signed the new one are asked to on their next visit
 * and can't be approved or published until they do.
 *
 * Nothing is enforced while no version is current, so it is safe to draft here
 * for as long as needed. Publishing is the switch.
 */

const EMPTY: AdminAgreementFields & { version: string } = {
  version: '',
  title: 'Facilitator Partnership Agreement',
  body_md: '',
  hilom_signatory: '',
  hilom_address: '',
};

const STATUS_LABEL: Record<AdminAgreementVersion['status'], string> = {
  draft: 'Draft',
  current: 'Current',
  retired: 'Retired',
};

export default function AgreementsTab({ adminKey }: { adminKey: string }) {
  const [versions, setVersions] = useState<AdminAgreementVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `null` = list view; `'new'` = drafting from scratch; otherwise the version being viewed/edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [preview, setPreview] = useState(false);

  async function load() {
    try {
      setVersions(await adminListAgreementVersions(adminKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agreement versions');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  const current = versions?.find((v) => v.status === 'current') ?? null;
  const editingVersion = versions?.find((v) => v.version === editing) ?? null;
  const readOnly = editingVersion !== null && editingVersion.status !== 'draft';

  function openNew() {
    // Start from the newest text so a revision is an edit, not a re-paste.
    const base = current ?? versions?.[0] ?? null;
    setForm({
      ...EMPTY,
      version: new Date().toISOString().slice(0, 10),
      body_md: base?.body_md ?? '',
      hilom_signatory: base?.hilom_signatory ?? '',
      hilom_address: base?.hilom_address ?? '',
    });
    setEditing('new');
    setPreview(false);
    setError(null);
  }

  function openExisting(v: AdminAgreementVersion) {
    setForm({
      version: v.version,
      title: v.title,
      body_md: v.body_md,
      hilom_signatory: v.hilom_signatory ?? '',
      hilom_address: v.hilom_address ?? '',
    });
    setEditing(v.version);
    setPreview(false);
    setError(null);
  }

  async function save(): Promise<AdminAgreementVersion | null> {
    setBusy(true);
    setError(null);
    try {
      const { version, ...fields } = form;
      const saved =
        editing === 'new'
          ? (await adminCreateAgreementVersion(adminKey, { version, ...fields })).version
          : (await adminUpdateAgreementVersion(adminKey, editing as string, fields)).version;
      await load();
      setEditing(saved.version);
      adminToast.success('Draft saved');
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    const saved = await save();
    if (!saved) return;
    const ok = await adminConfirm({
      title: `Publish version ${saved.version}?`,
      body:
        'The words are frozen once published. Every new applicant signs this version, and facilitators who have not ' +
        'signed it will be asked to sign before they can continue — and cannot be approved or published until they do.' +
        (current ? ` Version ${current.version} will be retired.` : ''),
      confirmLabel: 'Publish',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await adminPublishAgreementVersion(adminKey, saved.version);
      await load();
      setEditing(null);
      adminToast.success(`Version ${saved.version} is now current`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish');
    } finally {
      setBusy(false);
    }
  }

  if (editing !== null) {
    const shown = fillAgreement(form.body_md, {
      hilom_signatory: form.hilom_signatory,
      hilom_address: form.hilom_address,
    });
    return (
      <div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>
            {editing === 'new' ? 'New agreement draft' : `Version ${editing}`}
            {editingVersion && <span className="pill" style={{ marginLeft: '0.6rem' }}>{STATUS_LABEL[editingVersion.status]}</span>}
          </h2>
          <button type="button" className="btn btn-ghost small" onClick={() => setEditing(null)}>
            ← All versions
          </button>
        </div>

        {error && <div className="alert alert-error" style={{ marginTop: '1rem' }}>{error}</div>}
        {readOnly && (
          <div className="alert alert-info" style={{ marginTop: '1rem' }}>
            This version is published and can't be edited. To change the agreement, start a new draft — it
            begins as a copy of this text.
          </div>
        )}

        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 200px' }}>
              <span>Version id</span>
              <input
                value={form.version}
                disabled={editing !== 'new'}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="2026-10-01"
              />
            </label>
            <label className="field" style={{ flex: '2 1 300px' }}>
              <span>Title</span>
              <input
                value={form.title}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
          </div>
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 260px' }}>
              <span>Hilom authorized representative</span>
              <input
                value={form.hilom_signatory}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, hilom_signatory: e.target.value })}
                placeholder="Name and title of who signs for Hilom"
              />
            </label>
            <label className="field" style={{ flex: '2 1 300px' }}>
              <span>Hilom principal address</span>
              <input
                value={form.hilom_address}
                disabled={readOnly}
                onChange={(e) => setForm({ ...form, hilom_address: e.target.value })}
              />
            </label>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Agreement text</strong>
            <button type="button" className="btn btn-ghost small" onClick={() => setPreview((p) => !p)}>
              {preview ? 'Edit text' : 'Preview'}
            </button>
          </div>
          <p className="small muted" style={{ margin: '0.2rem 0 0.6rem' }}>
            Markdown subset: <code># Title</code>, <code>## Section</code>, <code>### Sub-section</code>,{' '}
            <code>- bullet</code>, blank line between paragraphs. Placeholders filled per signer:{' '}
            <code>{'{{effective_date}}'}</code> <code>{'{{hilom_signatory}}'}</code> <code>{'{{hilom_address}}'}</code>{' '}
            <code>{'{{facilitator_name}}'}</code> <code>{'{{facilitator_address}}'}</code>{' '}
            <code>{'{{facilitator_contact}}'}</code>
          </p>
          {preview ? (
            <div className="agreement-scroll" style={{ maxHeight: 520 }}>
              <AgreementText markdown={shown} />
            </div>
          ) : (
            <textarea
              value={form.body_md}
              disabled={readOnly}
              onChange={(e) => setForm({ ...form, body_md: e.target.value })}
              rows={24}
              style={{ width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.85rem' }}
            />
          )}

          {!readOnly && (
            <div className="row" style={{ gap: '0.6rem', marginTop: '1rem' }}>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save()}>
                Save draft
              </button>
              <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void publish()}>
                Save &amp; publish…
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Facilitator agreement</h2>
        <button type="button" className="btn btn-accent small" onClick={openNew}>
          New draft
        </button>
      </div>
      <p className="muted" style={{ marginTop: '0.4rem' }}>
        {current
          ? `Version ${current.version} is current: ${current.signed} signed, ${current.countersigned} countersigned. New applicants sign it as part of the application.`
          : 'No version is published, so facilitators are not being asked to sign and nothing is gated. Publish a draft to switch it on.'}
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      {!versions && !error && <div className="spinner" aria-label="Loading" />}
      {versions?.map((v) => (
        <div key={v.version} className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>
              {v.title} <span className="muted">· {v.version}</span>
            </strong>
            <span className={`pill ${v.status === 'current' ? 'pill-ok' : ''}`}>{STATUS_LABEL[v.status]}</span>
          </div>
          <p className="small muted" style={{ margin: '0.25rem 0 0.6rem' }}>
            {v.published_at
              ? `Published ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(v.published_at))} · ${v.signed} signed · ${v.countersigned} countersigned`
              : `Created ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(v.created_at))}${v.created_by ? ` by ${v.created_by}` : ''}`}
          </p>
          <button type="button" className="btn btn-ghost small" onClick={() => openExisting(v)}>
            {v.status === 'draft' ? 'Edit' : 'View'}
          </button>
        </div>
      ))}
    </div>
  );
}

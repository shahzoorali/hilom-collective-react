/**
 * Admin → Facilitators.
 *
 * The approval queue. Applications land here as `applied`; nothing is publicly
 * listed until someone reads one and decides.
 *
 * The two-step approve → publish is deliberate and is reflected in the buttons:
 * `approved` gives dashboard access so a facilitator can set up services and
 * hours, `published` puts them in the directory. Collapsing them into one
 * action would mean every newly approved facilitator goes live with an empty
 * profile and no availability.
 */
import { useCallback, useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import {
  adminCreateFacilitator,
  adminGetFacilitator,
  adminListFacilitators,
  adminPatchFacilitator,
  type AdminFacilitator,
  type Booking,
  type FacilitatorService,
  type FacilitatorStatus,
} from '../../lib/booking';

const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: 'Needs review', value: 'applied' },
  { label: 'Approved', value: 'approved' },
  { label: 'Published', value: 'published' },
  { label: 'Suspended', value: 'suspended' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Everyone', value: '' },
];

const STATUS_PILL: Record<string, string> = {
  applied: 'pill-warn',
  approved: 'pill',
  published: 'pill-ok',
  suspended: 'pill-bad',
  rejected: 'pill-bad',
};

export default function FacilitatorsTab({ adminKey }: { adminKey: string }) {
  const [filter, setFilter] = useState('applied');
  const [facilitators, setFacilitators] = useState<AdminFacilitator[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    facilitator: AdminFacilitator;
    services: FacilitatorService[];
    bookings: Booking[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState({
    email: '',
    display_name: '',
    headline: '',
    credentials: '',
    specialties: '',
    scope_note: '',
    admin_notes: '',
  });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminListFacilitators(adminKey, filter || undefined)
      .then(setFacilitators)
      .catch((err: Error) => setError(err.message));
  }, [adminKey, filter]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let live = true;
    adminGetFacilitator(adminKey, openId)
      .then((d) => live && setDetail(d))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [adminKey, openId]);

  async function setStatus(facilitatorId: string, status: FacilitatorStatus) {
    const confirmations: Partial<Record<FacilitatorStatus, string>> = {
      approved:
        'Approve this facilitator?\n\nThey get dashboard access and an email, but are not listed publicly yet.',
      published: 'Publish this profile?\n\nThey become visible in the directory and bookable.',
      suspended:
        'Suspend this facilitator?\n\nThey are hidden from the directory and lose dashboard access. Existing bookings are not cancelled.',
      rejected: 'Reject this application?',
    };
    const message = confirmations[status];
    if (message && !window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      await adminPatchFacilitator(adminKey, facilitatorId, { status });
      setNotice(`Status set to ${status}`);
      reload();
      if (openId === facilitatorId) {
        setDetail(await adminGetFacilitator(adminKey, facilitatorId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  async function setFee(facilitatorId: string, current: number) {
    const input = window.prompt(
      'Platform fee for this facilitator, as a percentage.\n\nOnly affects future bookings — the split is snapshotted on each booking when it is taken.',
      String(current / 100),
    );
    if (input === null) return;
    const percent = Number(input);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      setError('Fee must be a percentage between 0 and 100');
      return;
    }
    try {
      await adminPatchFacilitator(adminKey, facilitatorId, {
        platform_fee_bps: Math.round(percent * 100),
      });
      setNotice(`Fee set to ${percent}%`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    }
  }

  const lines = (value: string) =>
    value.split('\n').map((s) => s.trim()).filter(Boolean);

  async function createFacilitator() {
    if (!addDraft.email.trim() || !addDraft.display_name.trim()) {
      setAddError('Email and name are required');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      const created = await adminCreateFacilitator(adminKey, {
        email: addDraft.email.trim(),
        display_name: addDraft.display_name.trim(),
        headline: addDraft.headline.trim() || undefined,
        credentials: lines(addDraft.credentials),
        specialties: lines(addDraft.specialties),
        scope_note: addDraft.scope_note.trim() || undefined,
        admin_notes: addDraft.admin_notes.trim() || undefined,
      });
      setAddOpen(false);
      setAddDraft({
        email: '',
        display_name: '',
        headline: '',
        credentials: '',
        specialties: '',
        scope_note: '',
        admin_notes: '',
      });
      setNotice(`${created.display_name} added — review and approve when ready.`);
      setFilter('applied');
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add facilitator');
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Facilitators</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-accent small"
          style={{ marginLeft: 'auto' }}
          onClick={() => setAddOpen((o) => !o)}
        >
          {addOpen ? 'Cancel' : '+ Add facilitator'}
        </button>
      </div>

      {addOpen && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Add a facilitator directly</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            For someone Hilom has already vetted elsewhere — a referral, someone recruited directly.
            This lands them in "Needs review" like a normal application, so you still Approve and
            Publish separately below.
          </p>

          {addError && <div className="alert alert-error">{addError}</div>}

          <div className="two-col">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={addDraft.email}
                onChange={(e) => setAddDraft((d) => ({ ...d, email: e.target.value }))}
              />
              <small className="muted">Must match the email they'll sign in with.</small>
            </label>
            <label className="field">
              <span>Name shown to clients</span>
              <input
                value={addDraft.display_name}
                onChange={(e) => setAddDraft((d) => ({ ...d, display_name: e.target.value }))}
              />
            </label>
          </div>

          <label className="field">
            <span>Headline</span>
            <input
              value={addDraft.headline}
              onChange={(e) => setAddDraft((d) => ({ ...d, headline: e.target.value }))}
              placeholder="Somatic coach for people in career transitions"
            />
          </label>

          <label className="field">
            <span>Credentials — one per line</span>
            <textarea
              rows={3}
              value={addDraft.credentials}
              onChange={(e) => setAddDraft((d) => ({ ...d, credentials: e.target.value }))}
            />
          </label>

          <label className="field">
            <span>What they help with — one per line</span>
            <textarea
              rows={3}
              value={addDraft.specialties}
              onChange={(e) => setAddDraft((d) => ({ ...d, specialties: e.target.value }))}
            />
          </label>

          <label className="field">
            <span>Scope of practice</span>
            <textarea
              rows={2}
              value={addDraft.scope_note}
              onChange={(e) => setAddDraft((d) => ({ ...d, scope_note: e.target.value }))}
            />
          </label>

          <label className="field">
            <span>Admin notes (internal — never shown publicly)</span>
            <textarea
              rows={2}
              value={addDraft.admin_notes}
              onChange={(e) => setAddDraft((d) => ({ ...d, admin_notes: e.target.value }))}
              placeholder="Where this referral came from, anything worth remembering at review time."
            />
          </label>

          <button type="button" className="btn btn-accent small" disabled={addBusy} onClick={() => void createFacilitator()}>
            {addBusy ? 'Adding…' : 'Add facilitator'}
          </button>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {facilitators === null && <div className="spinner" aria-label="Loading" />}
      {facilitators !== null && facilitators.length === 0 && (
        <p className="muted">Nothing here.</p>
      )}

      {(facilitators ?? []).map((f) => (
        <div key={f.id} className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{f.display_name}</strong>
            <span className={`pill ${STATUS_PILL[f.status] ?? ''}`}>{f.status}</span>
          </div>
          <p className="small muted" style={{ margin: '0.25rem 0 0.6rem' }}>
            {f.email} · applied{' '}
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(f.applied_at))} ·
            fee {(f.platform_fee_bps / 100).toFixed(f.platform_fee_bps % 100 ? 2 : 0)}%
          </p>

          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost small" onClick={() => setOpenId(f.id)}>
              Review
            </button>
            {f.status === 'applied' && (
              <>
                <button
                  type="button"
                  className="btn btn-accent small"
                  disabled={busy}
                  onClick={() => void setStatus(f.id, 'approved')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busy}
                  onClick={() => void setStatus(f.id, 'rejected')}
                >
                  Reject
                </button>
              </>
            )}
            {f.status === 'approved' && (
              <button
                type="button"
                className="btn btn-accent small"
                disabled={busy}
                onClick={() => void setStatus(f.id, 'published')}
              >
                Publish
              </button>
            )}
            {f.status === 'published' && (
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => void setStatus(f.id, 'suspended')}
              >
                Suspend
              </button>
            )}
            {f.status === 'suspended' && (
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => void setStatus(f.id, 'published')}
              >
                Reinstate
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => void setFee(f.id, f.platform_fee_bps)}
            >
              Fee
            </button>
          </div>
        </div>
      ))}

      {openId && (
        <div className="admin-drawer-overlay" role="dialog" aria-modal="true">
          <div className="admin-drawer">
            <header className="admin-drawer-header">
              <h3 style={{ margin: 0 }}>{detail?.facilitator.display_name ?? 'Loading…'}</h3>
              <button type="button" className="btn btn-ghost small" onClick={() => setOpenId(null)}>
                Close
              </button>
            </header>

            <div className="admin-drawer-body">
              {!detail && <div className="spinner" aria-label="Loading" />}
              {detail && (
                <>
                  <p className="small muted">
                    {detail.facilitator.email}
                    {detail.facilitator.phone && <> · {detail.facilitator.phone}</>}
                    {detail.facilitator.legal_name && <> · legal name {detail.facilitator.legal_name}</>}
                  </p>

                  {detail.facilitator.headline && <p>{detail.facilitator.headline}</p>}

                  <h4>Credentials</h4>
                  {detail.facilitator.credentials.length === 0 ? (
                    // Worth flagging: this is the field the whole review exists
                    // to check, and an empty one should not slide past.
                    <p className="small" style={{ color: 'var(--danger-fg, inherit)' }}>
                      None given — worth asking before approving.
                    </p>
                  ) : (
                    <ul>
                      {detail.facilitator.credentials.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                  )}

                  <h4>Scope of practice</h4>
                  <p className="small">
                    {detail.facilitator.scope_note || (
                      <em>Not stated — required before publishing.</em>
                    )}
                  </p>

                  {detail.facilitator.bio && (
                    <>
                      <h4>Approach</h4>
                      <div
                        className="small"
                        dangerouslySetInnerHTML={{ __html: detail.facilitator.bio }}
                      />
                    </>
                  )}

                  <h4>Services ({detail.services.length})</h4>
                  {detail.services.map((s) => (
                    <p key={s.id} className="small" style={{ margin: '0.2rem 0' }}>
                      {s.title} · {s.duration_minutes} min ·{' '}
                      {s.price_centavos === 0 ? 'Free' : money(s.price_centavos, s.currency)}
                      {!s.is_active && ' · inactive'}
                    </p>
                  ))}

                  <h4>Recent bookings ({detail.bookings.length})</h4>
                  {detail.bookings.slice(0, 10).map((b) => (
                    <p key={b.id} className="small" style={{ margin: '0.2rem 0' }}>
                      {new Intl.DateTimeFormat('en-PH', { dateStyle: 'short', timeStyle: 'short' }).format(
                        new Date(b.starts_at),
                      )}{' '}
                      · {b.status} · {money(b.price_centavos)} (fee {money(b.platform_fee_centavos)})
                    </p>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

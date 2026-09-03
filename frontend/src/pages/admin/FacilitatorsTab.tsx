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
  adminGetCertificateUrl,
  adminGetFacilitator,
  adminListFacilitators,
  adminPatchFacilitator,
  type AdminFacilitator,
  type Booking,
  type FacilitatorService,
  type FacilitatorStatus,
} from '../../lib/booking';
import {
  CONTACT_METHODS,
  PROGRAM_STATUSES,
  REFERRAL_SOURCES,
  SUPPORT_TRACKS,
  YEARS_EXPERIENCE,
  labelFor,
} from '../../lib/facilitator-intake';

/**
 * What must be true before a profile can go in the directory.
 *
 * These used to be warnings on the *approve* step, because the application
 * form collected them. It no longer does — an `applied` row now legitimately
 * has no credentials and no scope note, and flagging that at review time would
 * mean flagging every single application.
 *
 * They still have to be checked, though, and publishing is where it matters:
 * credentials and a scope-of-practice statement are what let a client tell
 * what kind of practitioner they are booking. So the check moved with the
 * decision it belongs to.
 */
function publishBlockers(f: AdminFacilitator, serviceCount: number): string[] {
  const missing: string[] = [];
  if (f.credentials.length === 0) missing.push('No credentials listed');
  if (!f.scope_note) missing.push('No scope-of-practice statement');
  if (!f.bio) missing.push('No “my approach” copy');
  if (serviceCount === 0) missing.push('No services set up — nothing to book');
  return missing;
}

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
  const [supportFilter, setSupportFilter] = useState('');
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
    adminListFacilitators(adminKey, filter || undefined, supportFilter || undefined)
      .then(setFacilitators)
      .catch((err: Error) => setError(err.message));
  }, [adminKey, filter, supportFilter]);

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

  /**
   * Opens a credential document in a new tab.
   *
   * The signed URL is minted on click and lives five minutes, so it cannot be
   * fetched with the row and held. `window.open` before the await would be
   * cleaner for popup blockers but would mean opening a blank tab that then
   * fails visibly if the request errors, so the error path wins here.
   */
  async function openCertificate(facilitatorId: string) {
    setError(null);
    try {
      const { url } = await adminGetCertificateUrl(adminKey, facilitatorId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that document');
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
        <select
          value={supportFilter}
          onChange={(e) => setSupportFilter(e.target.value)}
          aria-label="Filter by support track"
        >
          <option value="">Any track</option>
          {SUPPORT_TRACKS.map((t) => (
            <option key={t.value} value={t.value}>{t.number} {t.name}</option>
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

                  {/* ---------------------------------------------------------
                      The application itself. This is what the approve/reject
                      decision is actually made on — everything below it is
                      profile copy the facilitator writes after approval. */}
                  <h4>Application</h4>

                  <p className="small" style={{ margin: '0 0 0.4rem' }}>
                    Prefers <strong>{labelFor(CONTACT_METHODS, detail.facilitator.contact_method)}</strong>
                    {' · '}
                    {labelFor(YEARS_EXPERIENCE, detail.facilitator.years_experience)} in practice
                  </p>

                  <p className="small" style={{ margin: '0 0 0.6rem' }}>
                    Heard about Hilom via{' '}
                    {detail.facilitator.referral_source === 'other'
                      ? detail.facilitator.referral_source_other || 'Other'
                      : labelFor(REFERRAL_SOURCES, detail.facilitator.referral_source)}
                  </p>

                  <p className="small" style={{ margin: '0 0 0.3rem' }}><strong>Wants support with</strong></p>
                  {detail.facilitator.support_needed.length === 0 ? (
                    // Not a gap in the form — "I'm not sure yet, recommend
                    // something" is a real answer to the question below, and
                    // this is what it looks like on the row.
                    <p className="small muted" style={{ margin: '0 0 0.6rem' }}>
                      No track chosen — asked for Hilom's recommendation.
                    </p>
                  ) : (
                    <div className="row" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0 0 0.6rem' }}>
                      {detail.facilitator.support_needed.map((track) => (
                        <span key={track} className="pill pill-ok">
                          {labelFor(SUPPORT_TRACKS, track)}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="small" style={{ margin: '0 0 0.3rem' }}><strong>Where they are now</strong></p>
                  <ul className="small" style={{ margin: '0 0 0.6rem' }}>
                    {detail.facilitator.program_status.map((status) => (
                      <li key={status}>{labelFor(PROGRAM_STATUSES, status)}</li>
                    ))}
                  </ul>

                  {(detail.facilitator.website_url ||
                    Object.keys(detail.facilitator.social_links ?? {}).length > 0) && (
                    <p className="small" style={{ margin: '0 0 0.6rem' }}>
                      {detail.facilitator.website_url && (
                        <a href={detail.facilitator.website_url} target="_blank" rel="noreferrer">
                          Website
                        </a>
                      )}
                      {Object.entries(detail.facilitator.social_links ?? {}).map(([key, link]) => (
                        <span key={key}>
                          {' · '}
                          {/^https?:/.test(String(link)) ? (
                            <a href={String(link)} target="_blank" rel="noreferrer">{key}</a>
                          ) : (
                            String(link)
                          )}
                        </span>
                      ))}
                    </p>
                  )}

                  {detail.facilitator.cert_document_key && (
                    <p className="small" style={{ margin: '0 0 0.6rem' }}>
                      <button
                        type="button"
                        className="btn btn-ghost small"
                        onClick={() => void openCertificate(detail.facilitator.id)}
                      >
                        Open {detail.facilitator.cert_document_name ?? 'certification document'}
                      </button>
                    </p>
                  )}

                  {detail.facilitator.privacy_accepted_at && (
                    <p className="small muted" style={{ margin: '0 0 0.6rem' }}>
                      Privacy policy {detail.facilitator.privacy_policy_version ?? ''} accepted{' '}
                      {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
                        new Date(detail.facilitator.privacy_accepted_at),
                      )}
                    </p>
                  )}

                  {detail.facilitator.bio && (
                    <>
                      <h4>About their work</h4>
                      <div
                        className="small"
                        dangerouslySetInnerHTML={{ __html: detail.facilitator.bio }}
                      />
                    </>
                  )}

                  {/* ---------------------------------------------------------
                      Public profile copy. Empty on a fresh application by
                      design — the facilitator writes this in their dashboard
                      after approval, which is what the checklist below tracks. */}
                  <h4>Credentials</h4>
                  {detail.facilitator.credentials.length === 0 ? (
                    <p className="small muted">
                      Not added yet — they write these in their dashboard after approval.
                    </p>
                  ) : (
                    <ul>
                      {detail.facilitator.credentials.map((c) => <li key={c}>{c}</li>)}
                    </ul>
                  )}

                  <h4>Scope of practice</h4>
                  <p className="small">
                    {detail.facilitator.scope_note || (
                      <em className="muted">Not added yet.</em>
                    )}
                  </p>

                  {/* The gate that replaced the old approve-time warnings. */}
                  {detail.facilitator.status !== 'applied' &&
                    detail.facilitator.status !== 'rejected' && (
                      <PublishChecklist
                        facilitator={detail.facilitator}
                        serviceCount={detail.services.filter((s) => s.is_active).length}
                      />
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

/**
 * Whether this profile is ready for the directory.
 *
 * Informational rather than an enforced block on the Publish button: there are
 * legitimate reasons to publish someone whose copy is thin — a launch, a
 * facilitator Hilom is writing the profile for — and a hard gate would send
 * whoever hits it looking for a way around it. What it must not do is let the
 * omission be *invisible*, which is what happens today.
 */
function PublishChecklist({
  facilitator,
  serviceCount,
}: {
  facilitator: AdminFacilitator;
  serviceCount: number;
}) {
  const blockers = publishBlockers(facilitator, serviceCount);

  if (blockers.length === 0) {
    return (
      <div className="alert alert-success" style={{ marginTop: '1rem' }}>
        Profile is complete — ready to publish.
      </div>
    );
  }

  return (
    <div className="alert alert-info" style={{ marginTop: '1rem' }}>
      <strong>Not ready for the directory yet</strong>
      <ul className="small" style={{ margin: '0.4rem 0 0' }}>
        {blockers.map((b) => <li key={b}>{b}</li>)}
      </ul>
      <p className="small" style={{ margin: '0.5rem 0 0' }}>
        These are the facilitator's to fill in from their dashboard.
        {facilitator.status === 'applied' && ' They get access once approved.'}
      </p>
    </div>
  );
}

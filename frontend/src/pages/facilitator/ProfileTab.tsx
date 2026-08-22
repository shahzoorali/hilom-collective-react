/**
 * Facilitator → Profile.
 *
 * What the public sees, plus vacation mode and payout details.
 *
 * Four fields are conspicuously read-only: status, fee rate, profile URL and
 * email. They are shown because a facilitator should be able to see their own
 * terms without asking, and they are not editable because publishing yourself
 * or renegotiating your own commission is not a self-service operation. The
 * backend does not accept them from this screen either — the check is there,
 * not here.
 */
import { useState } from 'react';
import { updateMyFacilitatorProfile, type OwnProfile } from '../../lib/booking';

export default function ProfileTab({
  profile,
  onSaved,
}: {
  profile: OwnProfile;
  onSaved: (p: OwnProfile) => void;
}) {
  const [draft, setDraft] = useState({
    display_name: profile.display_name,
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
    photo_url: profile.photo_url ?? '',
    credentials: profile.credentials.join('\n'),
    specialties: profile.specialties.join('\n'),
    languages: profile.languages.join(', '),
    location: profile.location ?? '',
    delivery_mode: profile.delivery_mode,
    scope_note: profile.scope_note ?? '',
    timezone: profile.timezone,
    legal_name: profile.legal_name ?? '',
    phone: profile.phone ?? '',
    vacation_until: profile.vacation_until ? profile.vacation_until.slice(0, 10) : '',
    payout_bank: String((profile.payout_details as Record<string, unknown>)?.bank ?? ''),
    payout_account: String((profile.payout_details as Record<string, unknown>)?.account ?? ''),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const lines = (value: string) =>
    value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateMyFacilitatorProfile({
        display_name: draft.display_name,
        headline: draft.headline,
        bio: draft.bio,
        photo_url: draft.photo_url,
        credentials: lines(draft.credentials),
        specialties: lines(draft.specialties),
        languages: draft.languages.split(',').map((s) => s.trim()).filter(Boolean),
        location: draft.location,
        delivery_mode: draft.delivery_mode,
        scope_note: draft.scope_note,
        timezone: draft.timezone,
        legal_name: draft.legal_name,
        phone: draft.phone,
        // Date-only input, read as end-of-day so "away until the 20th" includes
        // the 20th rather than reopening at midnight on it.
        vacation_until: draft.vacation_until ? `${draft.vacation_until}T23:59:59` : null,
        payout_details: { bank: draft.payout_bank, account: draft.payout_account },
      });
      onSaved(saved);
      setNotice('Profile saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Profile</h2>
        <button type="button" className="btn btn-accent small" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Your terms</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Set by Hilom. Get in touch if something here looks wrong.
        </p>
        <p className="small" style={{ margin: 0 }}>
          Status: <strong>{profile.status}</strong> · Platform fee:{' '}
          <strong>{(profile.platform_fee_bps / 100).toFixed(profile.platform_fee_bps % 100 ? 2 : 0)}%</strong>
          {' · '}Profile URL: <span className="mono">/facilitators/{profile.slug}</span>
          {' · '}Email: <span className="mono">{profile.email}</span>
        </p>
      </div>

      <label className="field">
        <span>Name shown to clients</span>
        <input value={draft.display_name} onChange={(e) => set('display_name', e.target.value)} />
      </label>

      <label className="field">
        <span>Headline</span>
        <input
          value={draft.headline}
          onChange={(e) => set('headline', e.target.value)}
          placeholder="Somatic coach for people in career transitions"
        />
      </label>

      <label className="field">
        <span>Photo URL</span>
        <input value={draft.photo_url} onChange={(e) => set('photo_url', e.target.value)} />
      </label>

      <label className="field">
        <span>My approach</span>
        <textarea rows={8} value={draft.bio} onChange={(e) => set('bio', e.target.value)} />
        <small className="muted">Basic formatting is kept; anything else is stripped when saved.</small>
      </label>

      <label className="field">
        <span>What I help with — one per line</span>
        <textarea
          rows={5}
          value={draft.specialties}
          onChange={(e) => set('specialties', e.target.value)}
          placeholder={'Emotional wellbeing\nCareer transitions\nStress management'}
        />
        <small className="muted">These become the filters clients browse by.</small>
      </label>

      <label className="field">
        <span>Credentials — one per line</span>
        <textarea rows={4} value={draft.credentials} onChange={(e) => set('credentials', e.target.value)} />
      </label>

      {/* Sits next to credentials on purpose: the two are read together, and
          the whole point is that a client can tell what kind of practitioner
          they are booking before they book. */}
      <label className="field">
        <span>Scope of practice</span>
        <textarea
          rows={3}
          value={draft.scope_note}
          onChange={(e) => set('scope_note', e.target.value)}
          placeholder="I'm a wellness coach, not a licensed therapist. I don't diagnose or treat mental health conditions, and I'll refer on where that's what's needed."
        />
        <small className="muted">
          Shown prominently on your profile. Be specific about what you do and don't offer — it
          protects you as much as your clients.
        </small>
      </label>

      <div className="two-col">
        <label className="field">
          <span>Location</span>
          <input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="Manila" />
        </label>
        <label className="field">
          <span>Languages (comma separated)</span>
          <input value={draft.languages} onChange={(e) => set('languages', e.target.value)} />
        </label>
      </div>

      <div className="two-col">
        <label className="field">
          <span>Sessions are</span>
          <select
            value={draft.delivery_mode}
            onChange={(e) => set('delivery_mode', e.target.value as typeof draft.delivery_mode)}
          >
            <option value="online">Online</option>
            <option value="in_person">In person</option>
            <option value="both">Either</option>
          </select>
        </label>
        <label className="field">
          <span>Your timezone</span>
          <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
          <small className="muted">Your availability is stored against this.</small>
        </label>
      </div>

      <label className="field">
        <span>Away until (optional)</span>
        <input
          type="date"
          value={draft.vacation_until}
          onChange={(e) => set('vacation_until', e.target.value)}
        />
        <small className="muted">
          Pauses all new bookings without touching your weekly hours. Clear it to come back.
        </small>
      </label>

      <h3>Private</h3>
      <div className="two-col">
        <label className="field">
          <span>Legal name</span>
          <input value={draft.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
        </label>
        <label className="field">
          <span>Phone</span>
          <input value={draft.phone} onChange={(e) => set('phone', e.target.value)} />
        </label>
      </div>

      <div className="two-col">
        <label className="field">
          <span>Bank</span>
          <input value={draft.payout_bank} onChange={(e) => set('payout_bank', e.target.value)} />
        </label>
        <label className="field">
          <span>Account</span>
          <input value={draft.payout_account} onChange={(e) => set('payout_account', e.target.value)} />
        </label>
      </div>
      <p className="small muted">Used for your payouts. Never shown publicly.</p>
    </>
  );
}

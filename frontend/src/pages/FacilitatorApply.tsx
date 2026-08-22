/**
 * `/facilitators/apply` — become a facilitator.
 *
 * Signing in first, before the form, for the same reason Checkout and
 * BookingFlow do it: an unannounced bounce to amazoncognito.com after
 * someone has already started filling in their story reads as a scam, and
 * the application is keyed to the account's email either way.
 *
 * Submitting does not make anyone bookable. It lands the application in
 * Hilom's review queue (`applied`) — see FacilitatorsTab.tsx in the admin —
 * and nothing here is public until someone reads it and approves, then
 * publishes it.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';
import { applyAsFacilitator } from '../lib/booking';

const DELIVERY_MODES: { value: 'online' | 'in_person' | 'both'; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'in_person', label: 'In person' },
  { value: 'both', label: 'Either' },
];

export default function FacilitatorApply() {
  const user = currentUser();

  const [draft, setDraft] = useState({
    display_name: [user?.givenName, user?.familyName].filter(Boolean).join(' '),
    headline: '',
    bio: '',
    credentials: '',
    specialties: '',
    languages: '',
    location: '',
    delivery_mode: 'online' as 'online' | 'in_person' | 'both',
    scope_note: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ alreadyApplied?: boolean; status: string } | null>(null);

  // Re-checking here rather than trusting a stale closure: coming back from
  // sign-in re-renders this component fresh, so this only ever runs once
  // against the current session.
  useEffect(() => {
    if (user && !draft.display_name) {
      setDraft((d) => ({ ...d, display_name: [user.givenName, user.familyName].filter(Boolean).join(' ') }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const lines = (value: string) =>
    value.split('\n').map((s) => s.trim()).filter(Boolean);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await applyAsFacilitator({
        display_name: draft.display_name.trim(),
        headline: draft.headline.trim() || undefined,
        bio: draft.bio.trim() || undefined,
        credentials: lines(draft.credentials),
        specialties: lines(draft.specialties),
        languages: draft.languages.split(',').map((s) => s.trim()).filter(Boolean),
        location: draft.location.trim() || undefined,
        delivery_mode: draft.delivery_mode,
        scope_note: draft.scope_note.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>Facilitate on Hilom</h1>
          <p className="desc">
            Offer your coaching, breathwork, or wellness practice through the same site our clients
            already trust — you set your own hours and prices, and we handle booking and payment.
          </p>
          <div className="panel">
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>First, your Hilom account</h2>
            <p>
              Your application, and later your dashboard, live in this account — so let's set it up
              before the form.
            </p>
            <button
              className="btn btn-accent btn-block"
              type="button"
              onClick={() => void login('/facilitators/apply')}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (result) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>Facilitate on Hilom</h1>
          <div className="panel">
            {result.alreadyApplied ? (
              <>
                <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Already on file</h2>
                <p style={{ marginBottom: 0 }}>
                  There's already an application for {user.email}, currently{' '}
                  <strong>{result.status}</strong>.{' '}
                  {result.status === 'approved' || result.status === 'published' ? (
                    <>
                      Head to your <Link to="/facilitator">dashboard</Link> to finish setting up.
                    </>
                  ) : (
                    "We'll be in touch once it's been reviewed."
                  )}
                </p>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Application sent</h2>
                <p style={{ marginBottom: 0 }}>
                  Thank you — we'll read through what you shared and follow up by email. Once
                  approved, you'll get access to a dashboard to set your services and hours before
                  going live.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 640 }}>
        <h1>Facilitate on Hilom</h1>
        <p className="desc">
          Tell us about your practice. This isn't a contract — it's what we read to decide whether
          to bring you onto the platform, so be specific about what you actually do.
        </p>

        <form className="panel" onSubmit={onSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="field">
            <label>Your account</label>
            <p style={{ margin: '0.15rem 0 0', fontWeight: 600 }}>{user.email}</p>
          </div>

          <label className="field">
            <span>Name shown to clients</span>
            <input
              required
              value={draft.display_name}
              onChange={(e) => set('display_name', e.target.value)}
            />
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
            <span>Your approach</span>
            <textarea
              rows={6}
              value={draft.bio}
              onChange={(e) => set('bio', e.target.value)}
              placeholder="What drew you to this work, and how you actually run a session."
            />
          </label>

          <label className="field">
            <span>Credentials — one per line</span>
            <textarea
              required
              rows={3}
              value={draft.credentials}
              onChange={(e) => set('credentials', e.target.value)}
              placeholder={'MA Counselling Psychology, UP Diliman\nCertified breathwork facilitator, ...'}
            />
            <small className="muted">This is the field your review is decided on — be thorough.</small>
          </label>

          <label className="field">
            <span>What you help with — one per line</span>
            <textarea
              rows={3}
              value={draft.specialties}
              onChange={(e) => set('specialties', e.target.value)}
              placeholder={'Emotional wellbeing\nCareer transitions\nStress management'}
            />
            <small className="muted">These become the filters clients browse by.</small>
          </label>

          <label className="field">
            <span>Scope of practice</span>
            <textarea
              required
              rows={3}
              value={draft.scope_note}
              onChange={(e) => set('scope_note', e.target.value)}
              placeholder="I'm a wellness coach, not a licensed therapist. I don't diagnose or treat mental health conditions, and I'll refer on where that's what's needed."
            />
            <small className="muted">
              Shown on your public profile. Be specific about what you do and don't offer — it
              protects you as much as your clients.
            </small>
          </label>

          <div className="row" style={{ gap: '1rem' }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Location</span>
              <input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="Manila" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Languages (comma separated)</span>
              <input value={draft.languages} onChange={(e) => set('languages', e.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>Sessions are</span>
            <select
              value={draft.delivery_mode}
              onChange={(e) => set('delivery_mode', e.target.value as typeof draft.delivery_mode)}
            >
              {DELIVERY_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>

          <button className="btn btn-accent btn-block" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Submit application'}
          </button>
        </form>
      </div>
    </section>
  );
}

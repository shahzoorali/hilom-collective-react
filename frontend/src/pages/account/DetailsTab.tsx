/**
 * `/account/details` — the account itself, and where per-event details live.
 *
 * The name here is editable and writes through to two places: the Cognito
 * account (the identity of record) and the buyer's Moodle account, so the name
 * on a course page matches the name on this one. Email is *not* editable —
 * course access is permanent and keyed to that address, so changing it is an
 * identity operation with real blast radius, and it stays a support request.
 *
 * What *is* editable per event — dietary needs, an emergency contact, who is
 * attending — lives on each registration's own page, because those details
 * belong to a specific event, not to the account as a whole; a single "your
 * details" form covering every registration at once would either show fields
 * that make no sense for most events or need to know which event you meant.
 *
 * Name fallback: a buyer who registered themselves through the Hosted UI
 * signup form (email only) has no `given_name`/`family_name` claim, so the
 * token gives us nothing to show. Rather than a bare dash, we fall back to the
 * name on their most recent registration — the same person typed it, and it is
 * the best guess we have. It also seeds the edit form, so the common case is
 * confirming a name rather than typing one from scratch. It is only a display
 * fallback; nothing is written anywhere until the form is saved.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { currentUser, logout, setNameOverride } from '../../lib/auth';
import { updateMyProfile } from '../../lib/api';
import { listMyRegistrations } from '../../lib/registrations';

/**
 * Splits a one-line name into the two fields Cognito and Moodle both want.
 * Everything after the first token is the surname, which handles "Maria Clara
 * de los Santos" the way a trailing-word split would not.
 */
function splitName(full: string): { given: string; family: string } {
  const parts = full.trim().split(/\s+/);
  return { given: parts[0] ?? '', family: parts.slice(1).join(' ') };
}

export default function DetailsTab() {
  const user = currentUser();
  const tokenName = [user?.givenName, user?.familyName].filter(Boolean).join(' ');
  const [fallbackName, setFallbackName] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [given, setGiven] = useState(user?.givenName ?? '');
  const [family, setFamily] = useState(user?.familyName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    // Only reach for the fallback when the token gave us no name at all.
    if (!user || tokenName) return;
    let cancelled = false;
    listMyRegistrations()
      .then((regs) => {
        if (cancelled) return;
        const latest = [...regs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
        const name = latest?.registrant_name?.trim() || null;
        setFallbackName(name);
        // Seed the form too — but never clobber what the user has already typed.
        if (name) {
          const { given: g, family: f } = splitName(name);
          setGiven((prev) => prev || g);
          setFamily((prev) => prev || f);
        }
      })
      .catch(() => {
        /* A failed lookup just leaves the dash — nothing here is load-bearing. */
      });
    return () => {
      cancelled = true;
    };
  }, [user, tokenName]);

  if (!user) return null;

  const displayName = tokenName || fallbackName;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await updateMyProfile(given, family);
      // The id_token in this tab still carries the old claim until the next
      // sign-in, so cache what the server saved and render that instead.
      setNameOverride(res.givenName, res.familyName);
      setSaved(res.moodleSynced ? 'Saved. Your course pages will show the new name too.' : 'Saved.');
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your name — try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1>Your details</h1>

      <div className="panel">
        {editing ? (
          <form onSubmit={save}>
            <div className="field">
              <label className="small muted" htmlFor="given-name">
                First name
              </label>
              <input
                id="given-name"
                value={given}
                onChange={(e) => setGiven(e.target.value)}
                maxLength={60}
                autoComplete="given-name"
                required
              />
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label className="small muted" htmlFor="family-name">
                Last name
              </label>
              <input
                id="family-name"
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                maxLength={60}
                autoComplete="family-name"
                required
              />
            </div>
            {error && (
              <p className="small" style={{ color: 'crimson', marginTop: 10 }} role="alert">
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? 'Saving…' : 'Save name'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setGiven(user?.givenName ?? '');
                  setFamily(user?.familyName ?? '');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="field">
            <span className="small muted">Name</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <p style={{ margin: '2px 0 0' }}>{displayName || '—'}</p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSaved(null);
                  setEditing(true);
                }}
              >
                {displayName ? 'Edit' : 'Add your name'}
              </button>
            </div>
            {!tokenName && fallbackName && (
              <span className="small muted">From your most recent registration.</span>
            )}
            {saved && (
              <p className="small muted" style={{ marginTop: 6 }} role="status">
                {saved}
              </p>
            )}
          </div>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <span className="small muted">Email</span>
          <p style={{ margin: '2px 0 0' }}>{user.email}</p>
        </div>
        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          Your email is how your courses are tracked, so changing it is something we do for you — write to{' '}
          <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a>.
        </p>
      </div>

      <div className="panel">
        <p style={{ margin: 0 }}>
          Dietary needs, emergency contacts and who is attending are set per event — open a registration under{' '}
          <Link to="/account/registrations">Retreats &amp; events</Link> to edit those.
        </p>
      </div>

      <button type="button" className="btn btn-ghost" onClick={() => logout()}>
        Log out
      </button>
    </div>
  );
}

/**
 * `/account/details` — the account itself, and where per-event details live.
 *
 * The Cognito identity (name, email) is read-only here: it comes from the
 * verified id token, not a form, and changing it is a Cognito account
 * operation this dashboard does not attempt. What *is* editable per event —
 * dietary needs, an emergency contact, who is attending — lives on each
 * registration's own page, because those details belong to a specific event,
 * not to the account as a whole; a single "your details" form covering every
 * registration at once would either show fields that make no sense for most
 * events or need to know which event you meant.
 */
import { Link } from 'react-router-dom';
import { currentUser, logout } from '../../lib/auth';

export default function DetailsTab() {
  const user = currentUser();
  if (!user) return null;

  return (
    <div>
      <h1>Your details</h1>

      <div className="panel">
        <div className="field">
          <span className="small muted">Name</span>
          <p style={{ margin: '2px 0 0' }}>{[user.givenName, user.familyName].filter(Boolean).join(' ') || '—'}</p>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <span className="small muted">Email</span>
          <p style={{ margin: '2px 0 0' }}>{user.email}</p>
        </div>
        <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
          This comes from your Hilom account. To change your name or email, write to{' '}
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

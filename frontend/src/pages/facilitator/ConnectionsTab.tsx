/**
 * Facilitator → Connections.
 *
 * Where a facilitator links their own Google or Zoom account so Hilom can
 * create a meeting link for each session in *their* account, with them as host.
 * Hilom holds no meeting account of its own — see
 * docs/meeting-link-integrations.md.
 *
 * The copy carries one load-bearing message: **you need an account with the
 * provider**. Someone without a Zoom account who picks Zoom on a service ends
 * up with sessions that have no way to join, discovered by a client at the
 * worst possible moment. So the requirement is stated on the card, before the
 * button, rather than in a tooltip or an error afterwards.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  disconnectProvider,
  listMyConnections,
  startConnectingProvider,
  type Connection,
  type IntegrationProvider,
} from '../../lib/booking';

/** Copy that belongs to the provider rather than to the connection's state. */
const BLURB: Record<IntegrationProvider, { requires: string; effect: string }> = {
  google_meet: {
    requires: 'Requires a Google account.',
    effect:
      'A fresh Meet link is created for each session. Hilom can only see the meetings it creates for you — not your calendar.',
  },
  zoom: {
    requires: 'Requires a Zoom account.',
    effect:
      'Each booking becomes a scheduled meeting in your own Zoom account, with you as host. A free Zoom account is fine for 1:1 sessions.',
  },
};

export default function ConnectionsTab() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<IntegrationProvider | null>(null);
  const [params, setParams] = useSearchParams();

  const reload = useCallback(() => {
    listMyConnections()
      .then(setConnections)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => reload(), [reload]);

  // The OAuth callback redirects back here with the outcome in the query
  // string, because a browser coming back from Google has no other way to be
  // told what happened. Read once, then stripped from the URL so a refresh
  // does not re-announce a connection made ten minutes ago.
  useEffect(() => {
    const connected = params.get('connected');
    if (!connected) return;

    if (connected === 'ok') setNotice('Account connected.');
    else if (connected === 'cancelled') setNotice('Connection cancelled — nothing was changed.');
    else setError(params.get('reason') || 'That connection could not be completed.');

    params.delete('connected');
    params.delete('reason');
    params.delete('provider');
    setParams(params, { replace: true });
  }, [params, setParams]);

  async function connect(provider: IntegrationProvider) {
    setBusy(provider);
    setError(null);
    try {
      // Full navigation, not fetch: the consent screen is the provider's page.
      window.location.href = await startConnectingProvider(provider, '/facilitator/connections');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start that connection');
      setBusy(null);
    }
  }

  async function remove(connection: Connection) {
    if (
      !window.confirm(
        `Disconnect ${connection.label}?\n\nSessions already booked keep their existing link. New bookings on services set to ${connection.label} will fall back to the link you enter manually.`,
      )
    )
      return;

    setBusy(connection.provider);
    setError(null);
    try {
      await disconnectProvider(connection.provider);
      setNotice(`${connection.label} disconnected.`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Connections</h2>
      <p className="small muted" style={{ maxWidth: '60ch' }}>
        Connect a video account and Hilom will create the meeting link for each session
        automatically, in your own account, with you as host. You can always enter a link by hand
        instead — connecting is optional.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {connections === null && <div className="spinner" aria-label="Loading" />}

      {(connections ?? []).map((c) => (
        <div key={c.provider} className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{c.label}</strong>
            {c.connected ? (
              <span className={`pill ${c.broken ? 'pill-bad' : 'pill-ok'}`}>
                {c.broken ? 'Needs reconnecting' : 'Connected'}
              </span>
            ) : (
              <span className="pill">Not connected</span>
            )}
          </div>

          {c.connected && c.email && (
            <p className="small muted" style={{ margin: '0.3rem 0 0' }}>
              Connected as {c.email}
              {c.connectedAt && (
                <>
                  {' · '}
                  since{' '}
                  {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(
                    new Date(c.connectedAt),
                  )}
                </>
              )}
            </p>
          )}

          {/* A revoked connection is only useful information if it says what to
              do about it. "Reconnect" is the only fix — retrying does nothing. */}
          {c.broken && (
            <div className="alert alert-error" style={{ margin: '0.6rem 0 0' }}>
              This connection stopped working — usually because access was removed from your{' '}
              {c.label} account. Reconnect it to keep creating links automatically.
            </div>
          )}

          <p className="small" style={{ margin: '0.5rem 0 0.75rem' }}>
            {BLURB[c.provider].effect}
            <br />
            <strong>{BLURB[c.provider].requires}</strong>
          </p>

          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {c.connected ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busy === c.provider}
                  onClick={() => void connect(c.provider)}
                >
                  {c.broken ? 'Reconnect' : 'Reconnect a different account'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busy === c.provider}
                  onClick={() => void remove(c)}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-accent small"
                disabled={busy === c.provider}
                onClick={() => void connect(c.provider)}
              >
                {busy === c.provider ? 'Opening…' : `Connect ${c.label}`}
              </button>
            )}
          </div>
        </div>
      ))}

      <p className="small muted" style={{ marginTop: '1.5rem', maxWidth: '60ch' }}>
        Hilom stores only what it needs to create meetings on your behalf, encrypted, and never
        reads your calendar or your existing meetings. Disconnecting removes Hilom's access
        immediately.
      </p>
    </>
  );
}

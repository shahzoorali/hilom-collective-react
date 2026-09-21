/**
 * Facilitator → Connections.
 *
 * Where a facilitator links their own Google or Zoom account so Hilom can
 * create a meeting link for each session in *their* account, with them as host.
 * Hilom holds no meeting account of its own — see
 * docs/meeting-link-integrations.md.
 *
 * The copy carries two load-bearing messages. The first: **you need an account
 * with the provider**. Someone without a Zoom account who picks Zoom on a service ends
 * up with sessions that have no way to join, discovered by a client at the
 * worst possible moment. So the requirement is stated on the card, before the
 * button, rather than in a tooltip or an error afterwards.
 *
 * The second: **Google will call this app unverified, and that is expected.**
 * See GOOGLE_UNVERIFIED below. Both notes sit before the button for the same
 * reason — once someone has left for the provider's consent screen, this page
 * has no way to say anything to them at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  createMyCalendarFeed,
  disconnectProvider,
  getMyCalendarFeed,
  listMyConnections,
  revokeMyCalendarFeed,
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

/**
 * Google shows "Google hasn't verified this app" before the consent screen,
 * because connecting needs the sensitive `meetings.space.created` scope and the
 * app has not been through Google's verification review yet.
 *
 * Every facilitator hits this, not just the first — so it is explained here
 * rather than answered one support message at a time. The wording matters: the
 * screen accuses Hilom of being unsafe, and a facilitator who is not told in
 * advance will reasonably stop. Saying it first, in our own voice, turns an
 * alarming dead end into an expected step.
 *
 * Flip to false once verification is granted and this whole note disappears
 * from every card — the only change needed.
 */
const GOOGLE_UNVERIFIED = true;

/** Which providers show the unverified-app warning. */
const SHOWS_UNVERIFIED_WARNING: IntegrationProvider[] = ['google_meet'];

/**
 * What to expect on Google's screen, and how to get past it.
 *
 * Deliberately not styled as an error. It is cream rather than red because
 * nothing has gone wrong — a red box here would confirm the very suspicion the
 * Google screen plants. Numbered, because it is a sequence of clicks and the
 * second one is hidden behind the first.
 */
function UnverifiedAppNote({ label }: { label: string }) {
  return (
    <div className="alert alert-info" style={{ margin: '0.6rem 0 0' }}>
      <strong>Google will say this app isn't verified — that's expected.</strong>
      <p className="small" style={{ margin: '0.4rem 0 0' }}>
        Hilom is new, and {label} access is still going through Google's review. Until that
        finishes you'll see a screen headed <em>"Google hasn't verified this app"</em>. Your
        account is safe; nothing is wrong. To continue:
      </p>
      <ol className="small" style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
        <li>
          Click <strong>Advanced</strong> — it's a small link at the bottom left, easy to miss.
        </li>
        <li>
          Click <strong>Go to Hilom Collective (unsafe)</strong>. The wording is Google's
          standard text for an app still in review, not a warning about your data.
        </li>
        <li>Then approve the permissions as normal.</li>
      </ol>
      <p className="small" style={{ margin: '0.4rem 0 0' }}>
        Hilom only ever sees the meetings it creates for you. It cannot read your calendar,
        your email or anything else in your account.
      </p>
    </div>
  );
}

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

    let attempted: string | null = null;
    try {
      attempted = sessionStorage.getItem('hilom.connectingProvider');
      sessionStorage.removeItem('hilom.connectingProvider');
    } catch {
      attempted = null;
    }

    if (connected === 'ok') setNotice('Account connected.');
    else if (connected === 'cancelled') {
      // "Back to safety" on Google's unverified-app screen arrives here as a
      // plain cancel. Saying only "cancelled" leaves someone who was trying to
      // do the right thing with no idea they were one hidden link away, so the
      // guidance is repeated at exactly the moment it is relevant.
      setNotice(
        GOOGLE_UNVERIFIED && attempted === 'google_meet'
          ? 'Connection cancelled — nothing was changed. If you stopped at the “Google hasn’t ' +
              'verified this app” screen, that one is expected: start again and choose Advanced, ' +
              'then “Go to Hilom Collective”.'
          : 'Connection cancelled — nothing was changed.',
      );
    } else setError(params.get('reason') || 'That connection could not be completed.');

    params.delete('connected');
    params.delete('reason');
    params.delete('provider');
    setParams(params, { replace: true });
  }, [params, setParams]);

  async function connect(provider: IntegrationProvider) {
    setBusy(provider);
    setError(null);
    try {
      // Which provider we left for. The cancelled callback cannot tell us —
      // it has no session to look the state row up against by the time it
      // redirects — so the answer is kept here, in the tab that asked.
      try {
        sessionStorage.setItem('hilom.connectingProvider', provider);
      } catch {
        // Private browsing, or storage disabled. The return message falls back
        // to the generic wording; nothing else depends on this.
      }
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

          {/* Only while unconnected: once they are through the warning it is
              noise, and a note that hides itself needs no dismiss button and no
              per-facilitator state to remember. Still shown for a broken
              connection, because reconnecting means meeting the screen again. */}
          {GOOGLE_UNVERIFIED &&
            SHOWS_UNVERIFIED_WARNING.includes(c.provider) &&
            (!c.connected || c.broken) && <UnverifiedAppNote label={c.label} />}

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

      <CalendarFeed />
    </>
  );
}

/**
 * A read-only feed of the facilitator's sessions, for their own calendar app.
 *
 * The opposite direction from the connections above: those let Hilom write a
 * meeting into the facilitator's provider account, this lets their calendar
 * read their sessions out. Grouped here because both answer "how does Hilom
 * meet the tools I already use".
 *
 * The copy has to be honest about what the link is. It carries a secret and
 * anyone holding it can read this facilitator's schedule, which is a real
 * thing to know before pasting it somewhere — and rotation is right there,
 * because the remedy needs to be as easy as the mistake.
 */
function CalendarFeed() {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyCalendarFeed()
      .then((r) => setUrl(r.url))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoaded(true));
  }, []);

  async function run(action: () => Promise<{ url: string | null }>) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setUrl((await action()).url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the feed');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright; the input below is
      // selectable, so there is a way through without it.
      setError('Could not copy — select the link and copy it by hand.');
    }
  }

  return (
    <>
      <h2 style={{ marginTop: '2.5rem' }}>Your sessions in your own calendar</h2>
      <p className="small muted" style={{ maxWidth: '60ch' }}>
        Subscribe to this link in Google Calendar, Apple Calendar or Outlook and your Hilom
        sessions appear alongside everything else. It is read-only — nothing you do in your
        calendar changes a booking here — and it updates on its own.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="panel">
        {!loaded && <div className="spinner" aria-label="Loading" />}

        {loaded && !url && (
          <>
            <p className="small" style={{ marginTop: 0 }}>
              You haven't set this up yet.
            </p>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void run(createMyCalendarFeed)}
            >
              {busy ? 'Creating…' : 'Create my calendar link'}
            </button>
          </>
        )}

        {loaded && url && (
          <>
            <label className="field">
              <span>Your private calendar link</span>
              <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <p className="small muted" style={{ marginTop: '-0.4rem' }}>
              Treat this like a password — anyone with the link can see your schedule. If you
              ever share it by accident, generate a new one and the old link stops working.
            </p>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-accent small" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Generate a new link?\n\nThe old one stops working immediately, and any calendar already subscribed to it will need the new one.',
                    )
                  ) {
                    void run(createMyCalendarFeed);
                  }
                }}
              >
                Generate a new link
              </button>
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Turn off the calendar feed?\n\nAny calendar subscribed to it will stop updating.',
                    )
                  ) {
                    void run(revokeMyCalendarFeed);
                  }
                }}
              >
                Turn it off
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

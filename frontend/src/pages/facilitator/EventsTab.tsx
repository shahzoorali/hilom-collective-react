/**
 * Facilitator → Events.
 *
 * Two things a host needs and, until now, had to ask an admin for: who has
 * actually registered, and control of the link people join on.
 *
 * The roster shown here is the admin roster — the same backend function
 * (lib/event-roster.ts), the same derived money figures. That is deliberate: a
 * host who emails an attendee about a missed instalment must be reading the
 * same number the admin is, or the two will contradict each other in front of
 * the person who paid.
 *
 * The joining link is saved and sent in two separate actions. Saving a
 * corrected dial-in note should not email forty people, and emailing forty
 * people should be something someone chose to do.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { money } from '../../components/Layout';
import {
  listMyHostedEvents,
  getMyHostedRoster,
  saveMyHostedJoinLink,
  sendMyHostedJoinDetails,
  type MyHostedEvent,
} from '../../lib/booking';
import type { AdminRegistration, RosterMoney } from '../../lib/cms';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Holding a place',
  confirmed: 'Confirmed',
  completed: 'Attended',
  cancelled: 'Cancelled',
  expired: 'Lapsed',
};

/** A date range, collapsed when start and end fall on the same day. */
function when(startsAt: string, endsAt: string | null): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      dateStyle: 'medium',
    }).format(new Date(iso));
  const start = fmt(startsAt);
  const end = endsAt ? fmt(endsAt) : null;
  return !end || end === start ? start : `${start} — ${end}`;
}

export default function EventsTab() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [events, setEvents] = useState<MyHostedEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyHostedEvents()
      .then(setEvents)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (events === null) return <div className="spinner" aria-label="Loading" />;

  if (eventId) {
    const hosted = events.find((e) => e.id === eventId);
    return (
      <EventDetail
        eventId={eventId}
        fallbackTitle={hosted?.title ?? 'Event'}
        onBack={() => navigate('/facilitator/events')}
      />
    );
  }

  return (
    <>
      <h2>Events</h2>
      {events.length === 0 && (
        <p className="muted">
          You are not hosting any events yet. When an event is assigned to you, it appears here
          with its registrations and its joining link.
        </p>
      )}

      {events.map((e) => (
        <div key={e.id} className="card" style={{ marginBottom: '0.6rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{e.title}</strong>
              {e.status !== 'published' && (
                <span className="small muted"> · not published yet</span>
              )}
              <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
                {when(e.starts_at, e.ends_at)}
                {e.location ? ` · ${e.location}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => navigate(`/facilitator/events/${e.id}`)}
            >
              Registrations
            </button>
          </div>

          <p className="small" style={{ margin: '0.5rem 0 0' }}>
            <strong>{e.registrations.confirmed}</strong> confirmed
            {e.registrations.pending > 0 && (
              <span className="muted"> · {e.registrations.pending} still paying</span>
            )}
            {!e.join_url && e.ticketing_enabled && (
              <span className="muted"> · no joining link set</span>
            )}
          </p>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

function EventDetail({
  eventId,
  fallbackTitle,
  onBack,
}: {
  eventId: string;
  fallbackTitle: string;
  onBack: () => void;
}) {
  const [roster, setRoster] = useState<{
    title: string;
    registrations: AdminRegistration[];
    money: RosterMoney;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The link as it is on the server, and the link as it is in the box. Kept
  // apart so the Send button can be disabled while there are unsaved edits —
  // the send reads the link from the server, so offering it while the box says
  // something else would email a link nobody saved.
  const [savedUrl, setSavedUrl] = useState('');
  const [url, setUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMyHostedRoster(eventId)
      .then((res) => {
        if (!live) return;
        setRoster({ title: res.event.title, registrations: res.registrations, money: res.money });
        setSavedUrl(res.joinLink.join_url ?? '');
        setUrl(res.joinLink.join_url ?? '');
        setInstructions(res.joinLink.join_instructions ?? '');
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [eventId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveMyHostedJoinLink(eventId, url.trim(), instructions.trim());
      setSavedUrl(res.joinLink.join_url ?? '');
      setUrl(res.joinLink.join_url ?? '');
      setInstructions(res.joinLink.join_instructions ?? '');
      setNotice(
        res.changed
          ? 'Saved. Everyone who registers from now on gets this link in their confirmation — use Send below to tell the people who already registered.'
          : 'Saved.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const who = confirmedCount;
    if (
      !window.confirm(
        `Email the joining details to ${who} confirmed ${who === 1 ? 'registrant' : 'registrants'}?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await sendMyHostedJoinDetails(eventId);
      // Reported split, because the two groups got materially different emails
      // and the sender should know that rather than infer it.
      const parts = [
        res.firstTime > 0 && `${res.firstTime} told for the first time`,
        res.resent > 0 && `${res.resent} told the link changed`,
      ].filter(Boolean);
      setNotice(
        res.sent === 0
          ? 'Nobody to send to — no confirmed registrations yet.'
          : `Sent to ${res.sent} ${res.sent === 1 ? 'person' : 'people'}${
              parts.length > 0 ? ` — ${parts.join(', ')}.` : '.'
            }`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const registrations = roster?.registrations ?? [];
  const confirmedCount = registrations.filter(
    (r) => r.status === 'confirmed' || r.status === 'completed',
  ).length;
  // Unsaved edits must not be sendable: the send reads the link from the
  // server, so offering it while the box says something else would email a
  // link nobody typed.
  const dirty = url.trim() !== savedUrl;

  return (
    <>
      <button type="button" className="linklike small" onClick={onBack}>
        ← All events
      </button>
      <h2>{roster?.title ?? fallbackTitle}</h2>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Joining link</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Sent in the confirmation email to everyone who registers, and shown on their own
          registration page once their place is paid for. Never shown publicly.
        </p>

        <label className="field">
          <span>Link</span>
          <input
            type="url"
            value={url}
            placeholder="https://us05web.zoom.us/j/..."
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Anything else they need to know</span>
          <textarea
            rows={2}
            value={instructions}
            placeholder="Waiting room opens 15 minutes early. Passcode is in the link."
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>

        <div className="row" style={{ gap: '0.5rem' }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || dirty || !savedUrl || confirmedCount === 0}
            onClick={() => void send()}
          >
            Send to {confirmedCount} confirmed
          </button>
        </div>
        {dirty && (
          <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
            Save your change before sending it out.
          </p>
        )}
      </div>

      {roster === null ? (
        <div className="spinner" aria-label="Loading" />
      ) : (
        <>
          <p className="small muted">
            {roster.money.placesTaken} of {roster.money.capacity || '—'} places ·{' '}
            {money(roster.money.collectedCentavos, roster.money.currency)} collected
            {roster.money.outstandingCentavos > 0 && (
              <> · {money(roster.money.outstandingCentavos, roster.money.currency)} still owed</>
            )}
          </p>

          {registrations.length === 0 && <p className="muted">Nobody has registered yet.</p>}

          {registrations.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: '0.5rem' }}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'baseline' }}
              >
                <div>
                  <strong>
                    #{r.seat_no} {r.registrant_name}
                  </strong>
                  <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                    <a href={`mailto:${r.registrant_email}`}>{r.registrant_email}</a>
                    {r.registrant_phone ? ` · ${r.registrant_phone}` : ''}
                  </p>
                </div>
                <span className="small">{STATUS_LABEL[r.status] ?? r.status}</span>
              </div>

              <p className="small" style={{ margin: '0.4rem 0 0' }}>
                {r.plan_name} · {money(r.paidCentavos, r.currency)} paid
                {r.outstandingCentavos > 0 && (
                  <span className="muted">
                    {' '}
                    · {money(r.outstandingCentavos, r.currency)} outstanding
                    {r.overdueCount > 0 && ` (${r.overdueCount} overdue)`}
                  </span>
                )}
              </p>

              {/* The per-event extras an admin configured on the event —
                  dietary needs, emergency contact, room preference. These are
                  precisely what a host reads the roster for, and they are why
                  this screen shows the whole registration rather than a name
                  and an email. */}
              {Object.entries(r.registrant_details ?? {}).length > 0 && (
                <dl className="small" style={{ margin: '0.4rem 0 0' }}>
                  {Object.entries(r.registrant_details).map(([k, v]) => (
                    <div key={k}>
                      <dt className="muted" style={{ display: 'inline' }}>
                        {k.replace(/_/g, ' ')}:{' '}
                      </dt>
                      <dd style={{ display: 'inline', margin: 0 }}>{v}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {r.cancellation_requested_at && !r.cancellation_decided_at && (
                <p className="small" style={{ margin: '0.4rem 0 0' }}>
                  <strong>Asked to cancel.</strong>{' '}
                  <span className="muted">
                    {r.cancellation_reason || 'No reason given.'} An admin decides this one.
                  </span>
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Facilitator → Clients.
 *
 * The bookings list answers "what is happening this week". This answers "who is
 * this person and what have we done" — the question a facilitator has thirty
 * seconds before a session with someone they last saw six weeks ago, and the
 * one a calendar ordered by time can never answer.
 *
 * Two kinds of writing, kept apart on purpose (see 0033): the standing note
 * about a person, which is edited constantly and read before every session, and
 * the note about one session, which is written afterwards and belongs to that
 * hour forever. One box for both would make every update to the first an edit
 * to the history of the second.
 *
 * Neither is ever shown to the client. That is enforced in the backend — the
 * client-facing handlers do not select these columns — but it is stated on the
 * screen too, because a facilitator who is unsure will write nothing useful.
 */
import { useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import {
  formatInZone,
  getMyClient,
  listMyClients,
  saveMyClientAbout,
  saveMySessionNotes,
  viewerTimezone,
  type ClientBooking,
  type ClientSummary,
} from '../../lib/booking';

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Upcoming',
  completed: 'Held',
  no_show: 'No-show',
  cancelled_by_client: 'Cancelled by them',
  cancelled_by_facilitator: 'Cancelled by you',
  refunded: 'Refunded',
};

export default function ClientsTab() {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = viewerTimezone();

  useEffect(() => {
    listMyClients()
      .then(setClients)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (clients === null) return <div className="spinner" aria-label="Loading" />;

  return (
    <>
      <h2>Clients</h2>
      {clients.length === 0 && (
        <p className="muted">Nobody yet. Clients appear here after their first booking.</p>
      )}

      {clients.map((c) => (
        <div key={c.email} className="card" style={{ marginBottom: '0.6rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{c.name || c.email}</strong>
              {c.name && <span className="small muted"> · {c.email}</span>}
            </div>
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => setOpenEmail(openEmail === c.email ? null : c.email)}
            >
              {openEmail === c.email ? 'Close' : 'Open'}
            </button>
          </div>

          <p className="small muted" style={{ margin: '0.3rem 0 0' }}>
            {c.sessions} session{c.sessions === 1 ? '' : 's'}
            {c.netCentavos > 0 && <> · {money(c.netCentavos)} earned</>}
            {c.nextSessionAt && (
              <>
                {' '}
                · next{' '}
                {formatInZone(c.nextSessionAt, zone, { dateStyle: 'medium', timeStyle: 'short' })}
              </>
            )}
            {!c.nextSessionAt && c.lastSessionAt && (
              <> · last seen {formatInZone(c.lastSessionAt, zone, { dateStyle: 'medium', timeStyle: undefined })}</>
            )}
            {c.hasAbout && <> · you have notes</>}
          </p>

          {openEmail === c.email && <ClientDetail email={c.email} zone={zone} />}
        </div>
      ))}
    </>
  );
}

/**
 * One client's standing note and their whole timeline.
 *
 * Loaded when opened rather than with the list: the timeline carries session
 * notes and intake answers for every booking, which is a lot of sensitive text
 * to ship for a roster the facilitator is only scanning.
 */
function ClientDetail({ email, zone }: { email: string; zone: string }) {
  const [about, setAbout] = useState('');
  const [bookings, setBookings] = useState<ClientBooking[] | null>(null);
  const [savingAbout, setSavingAbout] = useState(false);
  const [aboutSaved, setAboutSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMyClient(email)
      .then((r) => {
        if (!live) return;
        setAbout(r.about ?? '');
        setBookings(r.bookings);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [email]);

  async function persistAbout() {
    setSavingAbout(true);
    setError(null);
    try {
      await saveMyClientAbout(email, about);
      setAboutSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSavingAbout(false);
    }
  }

  if (error) return <div className="alert alert-error">{error}</div>;
  if (bookings === null) return <div className="spinner" aria-label="Loading" />;

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <label className="field">
        <span>About this client</span>
        <textarea
          rows={4}
          value={about}
          placeholder="What they're working on, what to remember, how you like to start."
          onChange={(e) => {
            setAbout(e.target.value);
            setAboutSaved(false);
          }}
        />
        <small className="muted">
          Only you can see this. It is not shown to the client and does not appear in any email.
        </small>
      </label>
      <button
        type="button"
        className="btn btn-ghost small"
        disabled={savingAbout}
        onClick={() => void persistAbout()}
      >
        {savingAbout ? 'Saving…' : aboutSaved ? 'Saved' : 'Save note'}
      </button>

      <h4 style={{ marginBottom: '0.4rem' }}>Your sessions together</h4>
      {bookings.map((b) => (
        <SessionRow key={b.id} booking={b} zone={zone} />
      ))}
    </div>
  );
}

/** One session in the timeline, with the note that belongs to it. */
function SessionRow({ booking, zone }: { booking: ClientBooking; zone: string }) {
  const [notes, setNotes] = useState(booking.session_notes ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveMySessionNotes(booking.id, notes);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const cancelled = booking.status.startsWith('cancelled') || booking.status === 'refunded';

  return (
    <div className="card" style={{ marginBottom: '0.5rem', opacity: cancelled ? 0.65 : 1 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong className="small">
          {formatInZone(booking.starts_at, zone, { dateStyle: 'medium', timeStyle: 'short' })}
        </strong>
        <span className="pill">{STATUS_LABEL[booking.status] ?? booking.status}</span>
      </div>
      <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
        {booking.facilitator_services?.title ?? 'Session'}
        {booking.booked_by === 'facilitator' && <> · booked by you</>}
        {booking.facilitator_net_centavos > 0 && <> · {money(booking.facilitator_net_centavos)}</>}
      </p>

      {booking.client_notes && (
        <p className="small" style={{ margin: '0.35rem 0 0' }}>
          <span className="muted">They wrote: </span>
          <em>“{booking.client_notes}”</em>
        </p>
      )}

      {booking.intake_answers.length > 0 && (
        <details style={{ marginTop: '0.35rem' }}>
          <summary className="small">Their pre-session answers</summary>
          <dl className="small" style={{ margin: '0.35rem 0 0' }}>
            {booking.intake_answers.map((a) => (
              <div key={a.id} style={{ marginBottom: '0.3rem' }}>
                <dt className="muted">{a.label}</dt>
                <dd style={{ margin: 0 }}>{a.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {!open && (
        <button
          type="button"
          className="btn btn-ghost small"
          style={{ marginTop: '0.4rem' }}
          onClick={() => setOpen(true)}
        >
          {booking.session_notes ? 'Your notes on this session' : 'Add a note'}
        </button>
      )}

      {!open && booking.session_notes && (
        <p className="small" style={{ margin: '0.35rem 0 0', whiteSpace: 'pre-wrap' }}>
          {booking.session_notes}
        </p>
      )}

      {open && (
        <>
          {error && <div className="alert alert-error">{error}</div>}
          <label className="field" style={{ marginTop: '0.4rem' }}>
            <span>Your notes on this session</span>
            <textarea
              rows={4}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setSaved(false);
              }}
            />
            <small className="muted">Private to you.</small>
          </label>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn btn-accent small" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
            <button type="button" className="btn btn-ghost small" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

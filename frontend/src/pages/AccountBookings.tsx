/**
 * `/account/bookings` — the first signed-in dashboard on the site.
 *
 * Upcoming and past, split, because they are used for different things:
 * upcoming is "what do I do next and how do I join", past is "what did I pay
 * for". The cancellation policy is stated on the confirmation dialog rather
 * than only in a footnote — someone cancelling 10 hours out should learn that
 * it is non-refundable *before* they confirm, not after.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../components/Layout';
import { currentUser, login } from '../lib/auth';
import {
  cancelBooking,
  listMyBookings,
  viewerTimezone,
  zoneLabel,
  type Booking,
} from '../lib/booking';

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'Missed',
  cancelled_by_client: 'Cancelled by you',
  cancelled_by_facilitator: 'Cancelled by facilitator',
  refunded: 'Refunded',
};

export default function AccountBookings() {
  const user = currentUser();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!user) return;
    listMyBookings()
      .then(setBookings)
      .catch((err: Error) => setError(err.message));
  }, [user]);

  useEffect(() => reload(), [reload]);

  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 520 }}>
          <h1>Your bookings</h1>
          <div className="panel">
            <p style={{ marginTop: 0 }}>Sign in to see your sessions.</p>
            <button
              type="button"
              className="btn btn-accent btn-block"
              onClick={() => void login('/account/bookings')}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  async function onCancel(booking: Booking) {
    const hours = (new Date(booking.starts_at).getTime() - Date.now()) / 3_600_000;
    // The policy, restated at the moment of decision rather than only in the
    // service description someone read a week ago.
    const consequence =
      booking.price_centavos === 0
        ? 'No payment was taken for this session.'
        : hours >= 24
          ? "You'll be refunded in full."
          : hours >= 12
            ? "You'll be refunded half — it's within 24 hours of the session."
            : "This is within 12 hours of the session, so it isn't refundable.";

    if (!window.confirm(`Cancel this session?\n\n${consequence}`)) return;

    setBusyId(booking.id);
    setError(null);
    try {
      const result = await cancelBooking(booking.id);
      setNotice(result.refundNote);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusyId(null);
    }
  }

  const zone = viewerTimezone();
  const now = Date.now();
  const upcoming = (bookings ?? []).filter(
    (b) => b.status === 'confirmed' && new Date(b.starts_at).getTime() > now,
  );
  const past = (bookings ?? []).filter((b) => !upcoming.includes(b));

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 760 }}>
        <h1>Your bookings</h1>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        {bookings === null && !error && <div className="spinner" aria-label="Loading" />}

        {bookings !== null && bookings.length === 0 && (
          <div className="panel">
            <p style={{ marginTop: 0 }}>You haven't booked a session yet.</p>
            <Link className="btn btn-accent" to="/facilitators">Find a facilitator</Link>
          </div>
        )}

        {upcoming.length > 0 && (
          <>
            <h2>Upcoming</h2>
            {upcoming.map((b) => (
              <div key={b.id} className="panel">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong>{b.facilitator_services?.title ?? 'Session'}</strong>
                  <span className="small muted">
                    {b.price_centavos === 0 ? 'Complimentary' : money(b.price_centavos, b.currency)}
                  </span>
                </div>

                <p style={{ margin: '0.5rem 0' }}>
                  {new Intl.DateTimeFormat('en-PH', {
                    dateStyle: 'full',
                    timeStyle: 'short',
                    timeZone: zone,
                  }).format(new Date(b.starts_at))}{' '}
                  <span className="small muted">({zoneLabel(zone)})</span>
                </p>

                {b.facilitators && (
                  <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
                    with{' '}
                    <Link to={`/facilitators/${b.facilitators.slug}`}>{b.facilitators.display_name}</Link>
                  </p>
                )}

                <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  {b.meeting_url && (
                    <a className="btn btn-accent" href={b.meeting_url} target="_blank" rel="noreferrer">
                      Join
                    </a>
                  )}
                  {/* Mirrors RESCHEDULE_MIN_NOTICE_HOURS in
                      backend/src/lib/booking-domain.ts. The server is the one
                      that enforces this; showing it here just means the rule
                      is visible before someone tries, rather than after. */}
                  {b.facilitators &&
                    (new Date(b.starts_at).getTime() - now) / 3_600_000 >= 24 && (
                      <Link className="btn btn-ghost small" to={`/facilitators/${b.facilitators.slug}`}>
                        Reschedule
                      </Link>
                    )}
                  <button
                    type="button"
                    className="btn btn-ghost small"
                    disabled={busyId === b.id}
                    onClick={() => void onCancel(b)}
                  >
                    {busyId === b.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>

                {(new Date(b.starts_at).getTime() - now) / 3_600_000 < 24 && (
                  <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
                    This session is within 24 hours, so it can no longer be moved — you can still
                    cancel, though the refund depends on how much notice you give.
                  </p>
                )}
              </div>
            ))}
          </>
        )}

        {past.length > 0 && (
          <>
            <h2 style={{ marginTop: '2.5rem' }}>Past</h2>
            {past.map((b) => (
              <div key={b.id} className="card" style={{ marginBottom: '0.75rem' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div>
                    <strong>{b.facilitator_services?.title ?? 'Session'}</strong>
                    <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
                      {new Intl.DateTimeFormat('en-PH', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: zone,
                      }).format(new Date(b.starts_at))}
                      {b.facilitators && <> · {b.facilitators.display_name}</>}
                    </p>
                  </div>
                  <span className="pill">{STATUS_LABEL[b.status] ?? b.status}</span>
                </div>
                {b.cancellation_reason && (
                  <p className="small muted" style={{ margin: '0.5rem 0 0' }}>{b.cancellation_reason}</p>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

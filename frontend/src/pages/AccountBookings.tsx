/**
 * `/account/bookings` — the first signed-in dashboard on the site.
 *
 * Upcoming and past, split, because they are used for different things:
 * upcoming is "what do I do next and how do I join", past is "what did I pay
 * for". The cancellation policy is stated on the confirmation dialog rather
 * than only in a footnote — someone cancelling 10 hours out should learn that
 * it is non-refundable *before* they confirm, not after.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../components/Layout';
import SlotPicker, { type SlotPickerHandle } from '../components/SlotPicker';
import { currentUser, login } from '../lib/auth';
import {
  cancelBooking,
  listMyBookings,
  rescheduleBooking,
  viewerTimezone,
  zoneLabel,
  type Booking,
} from '../lib/booking';

/**
 * Mirrors RESCHEDULE_MIN_NOTICE_HOURS in backend/src/lib/booking-domain.ts,
 * where the rule is actually enforced. Duplicated rather than fetched: it is
 * one number that changes about never, and a round trip to learn it would
 * delay the only thing this page exists to show.
 */
const RESCHEDULE_MIN_NOTICE_HOURS = 24;

const hoursUntil = (iso: string) => (new Date(iso).getTime() - Date.now()) / 3_600_000;

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

  /** The booking whose reschedule picker is open, if any. */
  const [movingId, setMovingId] = useState<string | null>(null);
  const [newSlot, setNewSlot] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const pickerRef = useRef<SlotPickerHandle>(null);

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

  function openMove(booking: Booking) {
    setMovingId(booking.id);
    setNewSlot(null);
    setMoveError(null);
    setNotice(null);
  }

  async function onMove(booking: Booking) {
    if (!newSlot) return;
    setBusyId(booking.id);
    setMoveError(null);
    try {
      const result = await rescheduleBooking(booking.id, newSlot);
      setMovingId(null);
      setNewSlot(null);
      setNotice(
        `Moved to ${new Intl.DateTimeFormat('en-PH', {
          dateStyle: 'full',
          timeStyle: 'short',
          timeZone: viewerTimezone(),
        }).format(new Date(result.startsAt))}. We've emailed you both.`,
      );
      reload();
    } catch (err) {
      // Covers the slot going in the seconds since it was offered, and the
      // 24-hour rule if the page has been open a while. Reload the grid so it
      // reflects reality rather than repeating the same failure.
      setMoveError(err instanceof Error ? err.message : 'Could not move this session');
      pickerRef.current?.reload();
      setNewSlot(null);
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
                  {/* The 24h gate is enforced server-side in
                      booking-domain.ts; hiding the control here just means the
                      rule is visible before someone tries, not after. */}
                  {b.facilitators && hoursUntil(b.starts_at) >= RESCHEDULE_MIN_NOTICE_HOURS && (
                    <button
                      type="button"
                      className="btn btn-ghost small"
                      onClick={() => (movingId === b.id ? setMovingId(null) : openMove(b))}
                    >
                      {movingId === b.id ? 'Keep this time' : 'Reschedule'}
                    </button>
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

                {hoursUntil(b.starts_at) < RESCHEDULE_MIN_NOTICE_HOURS && (
                  <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
                    This session is within {RESCHEDULE_MIN_NOTICE_HOURS} hours, so it can no longer
                    be moved — you can still cancel, though the refund depends on how much notice
                    you give.
                  </p>
                )}

                {movingId === b.id && b.facilitators && (
                  <div style={{ marginTop: '1rem', borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
                    <h3 style={{ fontSize: '1.05rem', marginTop: 0 }}>Pick a new time</h3>
                    <p className="small muted" style={{ marginTop: 0 }}>
                      Same session, same price — nothing is charged again.
                    </p>

                    <SlotPicker
                      handleRef={pickerRef}
                      facilitatorSlug={b.facilitators.slug}
                      serviceId={b.service_id}
                      facilitatorTimezone={b.facilitators.timezone}
                      facilitatorName={b.facilitators.display_name}
                      selected={newSlot}
                      onSelect={setNewSlot}
                    />

                    {moveError && (
                      <div className="alert alert-error" style={{ marginTop: '1rem' }}>{moveError}</div>
                    )}

                    {newSlot && (
                      <div style={{ marginTop: '1.25rem' }}>
                        <p style={{ margin: '0 0 0.75rem' }}>
                          Move to{' '}
                          <strong>
                            {new Intl.DateTimeFormat('en-PH', {
                              dateStyle: 'full',
                              timeStyle: 'short',
                              timeZone: zone,
                            }).format(new Date(newSlot))}
                          </strong>{' '}
                          <span className="small muted">({zoneLabel(zone)})</span>?
                        </p>
                        <button
                          type="button"
                          className="btn btn-accent"
                          disabled={busyId === b.id}
                          onClick={() => void onMove(b)}
                        >
                          {busyId === b.id ? 'Moving…' : 'Confirm new time'}
                        </button>
                      </div>
                    )}
                  </div>
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

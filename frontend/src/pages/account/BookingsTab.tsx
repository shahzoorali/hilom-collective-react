/**
 * `/account/bookings` — facilitator sessions.
 *
 * Was the standalone page `AccountBookings.tsx` — "the first signed-in
 * dashboard on the site" — moved into the shared `/account` shell with only
 * the outer section wrapper and its own sign-in gate removed; the shell owns
 * both now. The route itself is unchanged and must keep resolving: it is
 * already in sent email (booking-email.ts's ACCOUNT_BOOKINGS_URL).
 *
 * Upcoming and past are split because they are used for different things:
 * upcoming is "what do I do next and how do I join", past is "what did I pay
 * for". The cancellation policy is stated on the confirmation dialog rather
 * than only in a footnote — someone cancelling 10 hours out should learn that
 * it is non-refundable *before* they confirm, not after.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import SlotPicker, { type SlotPickerHandle } from '../../components/SlotPicker';
import { currentUser } from '../../lib/auth';
import {
  cancelBooking,
  listMyBookings,
  rescheduleBooking,
  respondToProposedTime,
  bookingRefundPolicy,
  formatDualZone,
  formatInZone,
  viewerTimezone,
  type Booking,
} from '../../lib/booking';

/**
 * How much notice this booking needs to be moved.
 *
 * Mirrors `canReschedule` in backend/src/lib/booking-domain.ts, where the rule
 * is enforced — and since 0027 the line is the service's own full-refund
 * threshold rather than a fixed 24 hours, for the reason set out there: a move
 * inside the paid-cancellation window would otherwise be strictly cheaper than
 * cancelling. Read off the booking's snapshot, so this page and the server are
 * looking at the same number even for a booking taken under an older policy.
 */
const moveNoticeHours = (booking: Booking) => bookingRefundPolicy(booking).refund_full_hours;

const hoursUntil = (iso: string) => (new Date(iso).getTime() - Date.now()) / 3_600_000;

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'Missed',
  cancelled_by_client: 'Cancelled by you',
  cancelled_by_facilitator: 'Cancelled by facilitator',
  refunded: 'Refunded',
};

export default function BookingsTab() {
  const user = currentUser();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  async function onCancel(booking: Booking) {
    const hours = hoursUntil(booking.starts_at);
    // The booking's own snapshotted ladder, not a hardcoded 24/12 — a
    // facilitator who requires 48 hours' notice must not have this dialog
    // promise their client a full refund at 25.
    const { refund_full_hours: full, refund_half_hours: half } = bookingRefundPolicy(booking);
    const consequence =
      booking.price_centavos === 0
        ? 'No payment was taken for this session.'
        : hours >= full
          ? "You'll be refunded in full."
          : hours >= half
            ? `You'll be refunded half — it's within ${full} hours of the session.`
            : `This is within ${half} hours of the session, so it isn't refundable.`;

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

  /**
   * Answer a time the facilitator suggested (0029).
   *
   * Accepting is what moves the session — the proposal changed nothing on its
   * own. The server re-verifies the slot, so "that time was just taken" is an
   * ordinary answer here rather than a fault, and it arrives as an error the
   * notice below shows.
   */
  async function onRespond(booking: Booking, accept: boolean) {
    setBusyId(booking.id);
    setError(null);
    setNotice(null);
    try {
      const result = await respondToProposedTime(booking.id, accept);
      setNotice(
        result.accepted
          ? `Moved to ${formatInZone(result.startsAt, viewerTimezone(), {
              dateStyle: 'full',
              timeStyle: 'short',
            })}. We've emailed you both.`
          : "Kept your original time — we've let your facilitator know.",
      );
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not answer that');
      reload();
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
  const upcoming = (bookings ?? []).filter((b) => b.status === 'confirmed' && new Date(b.starts_at).getTime() > now);
  const past = (bookings ?? []).filter((b) => !upcoming.includes(b));

  return (
    <div>
      <h1>Your sessions</h1>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {bookings === null && !error && <div className="spinner" aria-label="Loading" />}

      {bookings !== null && bookings.length === 0 && (
        <div className="panel">
          <p style={{ marginTop: 0 }}>You haven't booked a session yet.</p>
          <Link className="btn btn-accent" to="/facilitators">
            Find a facilitator
          </Link>
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

              {/* The facilitator's zone alongside the client's own. Someone
                  who books across a border should never have to work out what
                  time it is at the other end — see formatDualZone. */}
              <p style={{ margin: '0.5rem 0' }}>
                {formatDualZone(
                  b.starts_at,
                  {
                    timezone: b.facilitators?.timezone,
                    label: `for ${b.facilitators?.display_name ?? 'your facilitator'}`,
                  },
                  { dateStyle: 'full', timeStyle: 'short' },
                  zone,
                )}
              </p>

              {b.facilitators && (
                <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
                  with <Link to={`/facilitators/${b.facilitators.slug}`}>{b.facilitators.display_name}</Link>
                </p>
              )}

              {/* An offer, not a change — the session above is still the real
                  one until this is accepted. The copy has to keep saying so,
                  or someone declines by ignoring it and turns up at the wrong
                  time. */}
              {b.proposed_starts_at && (
                <div className="alert alert-warning" style={{ marginBottom: '0.75rem' }}>
                  <strong>
                    {b.facilitators?.display_name ?? 'Your facilitator'} has suggested moving this
                    to{' '}
                    {formatDualZone(
                      b.proposed_starts_at,
                      {
                        timezone: b.facilitators?.timezone,
                        label: `for ${b.facilitators?.display_name ?? 'them'}`,
                      },
                      { dateStyle: 'full', timeStyle: 'short' },
                      zone,
                    )}
                    .
                  </strong>
                  {b.proposed_note && (
                    <p className="small" style={{ margin: '0.4rem 0 0' }}>
                      <em>“{b.proposed_note}”</em>
                    </p>
                  )}
                  <p className="small" style={{ margin: '0.4rem 0 0.6rem' }}>
                    Nothing changes unless you accept. Decline and your session stays as it is.
                  </p>
                  <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-accent small"
                      disabled={busyId === b.id}
                      onClick={() => void onRespond(b, true)}
                    >
                      Accept the new time
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost small"
                      disabled={busyId === b.id}
                      onClick={() => void onRespond(b, false)}
                    >
                      Keep my original time
                    </button>
                  </div>
                </div>
              )}

              <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                {b.meeting_url && (
                  <a className="btn btn-accent" href={b.meeting_url} target="_blank" rel="noreferrer">
                    Join
                  </a>
                )}
                {b.facilitators && hoursUntil(b.starts_at) >= moveNoticeHours(b) && (
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

              {hoursUntil(b.starts_at) < moveNoticeHours(b) && (
                <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
                  This session is within {moveNoticeHours(b)} hours, so it can no longer be moved — you
                  can still cancel, though the refund depends on how much notice you give.
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

                  {moveError && <div className="alert alert-error" style={{ marginTop: '1rem' }}>{moveError}</div>}

                  {newSlot && (
                    <div style={{ marginTop: '1.25rem' }}>
                      <p style={{ margin: '0 0 0.75rem' }}>
                        Move to{' '}
                        <strong>
                          {formatDualZone(
                            newSlot,
                            {
                              timezone: b.facilitators?.timezone,
                              label: `for ${b.facilitators?.display_name ?? 'your facilitator'}`,
                            },
                            { dateStyle: 'full', timeStyle: 'short' },
                            zone,
                          )}
                        </strong>
                        ?
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
                    {formatInZone(b.starts_at, zone, { dateStyle: 'medium', timeStyle: 'short' })}
                    {b.facilitators && <> · {b.facilitators.display_name}</>}
                  </p>
                </div>
                <span className="pill">{STATUS_LABEL[b.status] ?? b.status}</span>
              </div>
              {b.cancellation_reason && (
                <p className="small muted" style={{ margin: '0.5rem 0 0' }}>
                  {b.cancellation_reason}
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * `/booking/processing` — where PayMongo returns the buyer.
 *
 * A direct copy of `Processing.tsx`'s shape, for the same reason it exists
 * there: payment confirmation arrives over a webhook, not on this redirect, so
 * the browser polls until the booking flips to `confirmed`. PayMongo cannot
 * template the booking id into `success_url`, so `BookingFlow` stashes it in
 * sessionStorage before redirecting and this screen reads it back.
 *
 * Free exploratory calls arrive here with `?bookingId=` in the query and are
 * already confirmed — the poll resolves on its first pass.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getBookingStatus, viewerTimezone, zoneLabel, type BookingStatusResult } from '../lib/booking';

const POLL_MS = 2500;
const SLOW_AFTER_MS = 40_000;

export default function BookingProcessing() {
  const [params] = useSearchParams();
  const [result, setResult] = useState<BookingStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(Date.now());

  const bookingId = params.get('bookingId') ?? sessionStorage.getItem('hilom.pendingBooking');

  useEffect(() => {
    if (!bookingId) {
      setError("We couldn't find that booking. Check your email for confirmation.");
      return;
    }

    let live = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const status = await getBookingStatus(bookingId);
        if (!live) return;
        setResult(status);

        if (status.status === 'confirmed') {
          // Only clear once genuinely confirmed: a reload mid-poll should not
          // lose the id and strand the buyer on an error screen.
          sessionStorage.removeItem('hilom.pendingBooking');
          return;
        }

        if (Date.now() - startedAt.current > SLOW_AFTER_MS) setSlow(true);
        timer = window.setTimeout(() => void poll(), POLL_MS);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    };

    void poll();
    return () => {
      live = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [bookingId]);

  if (error) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <div className="alert alert-error">{error}</div>
          <Link to="/account/bookings" className="btn btn-ghost">Your bookings</Link>
        </div>
      </section>
    );
  }

  const zone = viewerTimezone();

  if (result?.status === 'confirmed') {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>You're booked</h1>
          <div className="panel">
            <p style={{ marginTop: 0 }}>
              <strong>{result.serviceTitle}</strong>
              {result.facilitatorName && <> with {result.facilitatorName}</>}
            </p>
            <p>
              <strong>
                {new Intl.DateTimeFormat('en-PH', {
                  dateStyle: 'full',
                  timeStyle: 'short',
                  timeZone: zone,
                }).format(new Date(result.startsAt))}
              </strong>{' '}
              <span className="small muted">({zoneLabel(zone)})</span>
            </p>

            {result.meetingUrl ? (
              <a className="btn btn-accent btn-block" href={result.meetingUrl} target="_blank" rel="noreferrer">
                Join the session
              </a>
            ) : (
              <p className="small muted">Your facilitator will send joining details before the session.</p>
            )}

            <p className="small muted" style={{ marginBottom: 0 }}>
              We've emailed you a confirmation. You can reschedule or cancel from{' '}
              <Link to="/account/bookings">your bookings</Link>.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const cancelled = result?.status?.startsWith('cancelled') || result?.status === 'refunded';

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 560 }}>
        <h1>Confirming your booking</h1>
        <div className="panel" style={{ textAlign: 'center' }}>
          {!cancelled && <div className="spinner" aria-label="Confirming" />}
          <p>
            {cancelled
              ? 'This booking was cancelled. If you were charged, we will refund you — reply to your receipt and we will sort it out.'
              : "We're confirming your payment and holding your slot. This usually takes a few seconds."}
          </p>
          {slow && !cancelled && (
            <p className="small muted">
              Still working — payment confirmation can occasionally take a minute. You can safely
              leave this page; we'll email you as soon as it's confirmed.
            </p>
          )}
          <Link to="/account/bookings" className="linklike small">Your bookings</Link>
        </div>
      </div>
    </section>
  );
}

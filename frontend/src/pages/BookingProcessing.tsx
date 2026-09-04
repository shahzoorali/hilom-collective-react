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
 *
 * A multi-session package returns here too, with `?packageId=`. It is a
 * genuinely different outcome, not a variant of the same one: nothing has been
 * scheduled, so there is no booking to poll for and no time to show. It gets
 * its own branch below rather than a flag threaded through this one.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AddToCalendar from '../components/AddToCalendar';
import {
  getBookingStatus,
  listMyPackages,
  viewerTimezone,
  zoneLabel,
  type BookingStatusResult,
} from '../lib/booking';

const POLL_MS = 2500;
const SLOW_AFTER_MS = 40_000;

export default function BookingProcessing() {
  const [params] = useSearchParams();
  const [result, setResult] = useState<BookingStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(Date.now());

  const packageId = params.get('packageId') ?? sessionStorage.getItem('hilom.pendingPackage');
  const bookingId = packageId
    ? null
    : params.get('bookingId') ?? sessionStorage.getItem('hilom.pendingBooking');

  // Polled the same way and for the same reason — the webhook, not this
  // redirect, is what activates it — but the thing being waited for is a
  // package becoming usable rather than a session becoming confirmed.
  const [pkg, setPkg] = useState<{ sessionsTotal: number; title: string } | null>(null);

  useEffect(() => {
    if (!packageId) return;
    let live = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const packages = await listMyPackages();
        if (!live) return;
        const found = packages.find((p) => p.id === packageId);
        if (found) {
          sessionStorage.removeItem('hilom.pendingPackage');
          setPkg({
            sessionsTotal: found.sessions_total,
            title: found.facilitator_services?.title ?? 'your package',
          });
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
  }, [packageId]);

  useEffect(() => {
    if (packageId) return;
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
  }, [bookingId, packageId]);

  if (packageId) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          {error && <div className="alert alert-error">{error}</div>}
          {!error && !pkg && (
            <>
              <h1>Confirming your package…</h1>
              <div className="spinner" aria-label="Loading" />
              {slow && (
                <p className="muted">
                  This is taking longer than usual. Your payment has gone through — check your
                  email, or your bookings page in a moment.
                </p>
              )}
            </>
          )}
          {pkg && (
            <>
              <h1>Your package is ready</h1>
              {/* The one thing this screen has to say. Someone who reads
                  "confirmed" and waits for a calendar invite will still be
                  waiting in three weeks. */}
              <p>
                You have <strong>{pkg.sessionsTotal} sessions</strong> to use. Nothing is booked
                yet — choose your times whenever you like, one at a time.
              </p>
              <Link className="btn btn-accent" to="/account/bookings">
                Book your first session
              </Link>
            </>
          )}
        </div>
      </section>
    );
  }

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

            {/* The email confirmation already carries a calendar invite Gmail
                and Outlook auto-detect (see backend/src/lib/email-mime.ts) —
                this is the same event offered directly, for anyone who wants
                it now rather than from their inbox. */}
            <div style={{ marginTop: '0.75rem' }}>
              <AddToCalendar
                event={{
                  id: result.bookingId,
                  title: result.facilitatorName
                    ? `${result.serviceTitle} with ${result.facilitatorName}`
                    : (result.serviceTitle ?? 'Hilom session'),
                  startsAt: result.startsAt,
                  endsAt: result.endsAt,
                  location: result.meetingUrl ?? undefined,
                  description: result.meetingUrl ? `Join: ${result.meetingUrl}` : undefined,
                }}
              />
            </div>

            <p className="small muted" style={{ marginBottom: 0, marginTop: '0.75rem' }}>
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

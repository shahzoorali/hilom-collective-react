/**
 * `/events/registration/processing` — where PayMongo returns the registrant.
 *
 * Same shape as BookingProcessing.tsx and Processing.tsx, for the same reason
 * all three exist: confirmation arrives over a webhook, not on this redirect,
 * so the browser polls until the registration flips to `confirmed`. PayMongo
 * cannot template the registration id into `success_url`, so EventRegister
 * stashes it in sessionStorage before redirecting and this screen reads it
 * back.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { money } from '../components/Layout';
import { getRegistrationStatus, formatEventDates, type RegistrationStatus } from '../lib/registrations';

const POLL_MS = 2500;
const SLOW_AFTER_MS = 40_000;

const PENDING_KEY = 'hilom.pendingRegistration';

export default function RegistrationProcessing() {
  const [params] = useSearchParams();
  const [result, setResult] = useState<RegistrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(Date.now());

  const registrationId = params.get('registrationId') ?? sessionStorage.getItem(PENDING_KEY);

  useEffect(() => {
    if (!registrationId) {
      setError("We couldn't find that registration. Check your email for confirmation.");
      return;
    }

    let live = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const status = await getRegistrationStatus(registrationId);
        if (!live) return;
        setResult(status);

        if (status.status === 'confirmed') {
          // Only cleared once genuinely confirmed: a reload mid-poll must not
          // lose the id and strand someone who has already paid.
          sessionStorage.removeItem(PENDING_KEY);
          return;
        }

        // A lapsed hold is terminal — nothing further will arrive, so stop
        // polling rather than spinning until the tab is closed.
        if (status.status === 'expired' || status.status === 'cancelled') return;

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
  }, [registrationId]);

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 560 }}>
        {error && <div className="alert alert-error">{error}</div>}

        {!error && result?.status === 'confirmed' && (
          <div className="panel">
            <h1 style={{ marginTop: 0 }}>Your place is confirmed</h1>
            <p>
              You're going to <strong>{result.eventTitle}</strong>
              {result.startsAt && ` — ${formatEventDates(result.startsAt, null)}`}.
            </p>
            <p className="small muted">
              We've emailed your receipt and, if you're paying in instalments, the full schedule with dates.
            </p>
            <Link className="btn btn-accent" to={`/account/registrations/${result.registrationId}`}>
              View your registration
            </Link>
          </div>
        )}

        {!error && result?.status === 'expired' && (
          <div className="panel">
            <h1 style={{ marginTop: 0 }}>That place was released</h1>
            <p>
              The hold ran out before the payment came through, so the place went back on sale.{' '}
              <strong>Nothing has been charged.</strong> If you did pay, write to us at{' '}
              <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> and we'll sort it
              out.
            </p>
            <Link className="btn btn-ghost" to="/events">
              Back to events
            </Link>
          </div>
        )}

        {!error && result?.status === 'cancelled' && (
          <div className="panel">
            <h1 style={{ marginTop: 0 }}>This registration was cancelled</h1>
            <p>
              Get in touch at <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> if
              that isn't what you expected.
            </p>
          </div>
        )}

        {!error && (!result || result.status === 'pending_payment') && (
          <div className="panel" style={{ textAlign: 'center' }}>
            <div className="spinner" aria-label="Confirming your payment" style={{ margin: '0 auto 14px' }} />
            <h1 style={{ marginTop: 0 }}>Confirming your payment</h1>
            <p className="muted">
              This usually takes a few seconds. Please don't close this page.
              {result && ` ${money(result.totalCentavos, result.currency)} · ${result.planName}`}
            </p>
            {slow && (
              <div className="alert alert-info small">
                This is taking longer than usual. Your payment is safe — if this page is still spinning in a
                few minutes, check your email, and write to us at kumusta@hilomcollective.com if nothing has
                arrived.
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getOrderStatusByIntent, type OrderStatus } from '../lib/api';
import { MOODLE_URL } from '../config';

/**
 * Post-payment state. Payment is already confirmed by this point; what we're
 * waiting on is enrollment, which happens asynchronously via the webhook.
 *
 * The plan is explicit that this must not read as a broken purchase, so the
 * copy always leads with "payment confirmed" and only the access line changes.
 */
export default function Processing() {
  const [params] = useSearchParams();
  // A 3-D Secure return lands here with no query string, so fall back to the
  // intent stashed before the bank redirect.
  const intentId = params.get('intent') ?? sessionStorage.getItem('hilom.pendingIntent');
  const [status, setStatus] = useState<OrderStatus['status'] | 'unknown'>('pending');
  const [productName, setProductName] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    if (!intentId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = await getOrderStatusByIntent(intentId);
        if (cancelled) return;
        setStatus(s.status);
        if (s.productName) setProductName(s.productName);
        if (s.status === 'fulfilled' || s.status === 'failed') {
          sessionStorage.removeItem('hilom.pendingIntent');
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) {
        // After ~40s something is likely wrong on our side, so say so honestly
        // rather than spinning forever.
        if (Date.now() - started.current > 40_000) setSlow(true);
        setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [intentId]);

  const done = status === 'fulfilled';

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 620 }}>
        <div className="panel" style={{ textAlign: 'center' }}>
          {!done && <div className="spinner" />}

          <h1 style={{ fontSize: '1.6rem' }}>
            {done ? 'You’re all set' : 'Payment confirmed'}
          </h1>

          {done ? (
            <>
              <p>
                {productName ? <strong>{productName}</strong> : 'Your course'} is now available in your
                account.
              </p>
              <a className="btn btn-accent" href={MOODLE_URL} target="_blank" rel="noreferrer">
                Go to my courses
              </a>
              <p className="small muted" style={{ marginTop: '1rem', marginBottom: 0 }}>
                Log in with the same email you used at checkout.
              </p>
            </>
          ) : status === 'failed' ? (
            <div className="alert alert-error" style={{ textAlign: 'left' }}>
              Your payment went through, but we hit a problem setting up your course access. Nothing
              is lost — our team has been alerted and will finish setting it up. Contact us if you
              don’t hear back shortly.
            </div>
          ) : (
            <>
              <p className="muted">Setting up your access — this usually takes a few seconds.</p>
              {slow && (
                <div className="alert alert-info" style={{ textAlign: 'left' }}>
                  This is taking longer than usual. Your payment is safely recorded and your access
                  will be set up automatically — you can close this page and check your email.
                </div>
              )}
            </>
          )}

          {!intentId && (
            <p className="small muted">
              Waiting for payment confirmation… if you just completed a bank verification step this
              can take a moment.
            </p>
          )}
        </div>

        <p style={{ textAlign: 'center', marginTop: '1.25rem' }}>
          <Link to="/courses">Browse more courses</Link>
        </p>
      </div>
    </section>
  );
}

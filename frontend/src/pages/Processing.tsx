import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getOrderStatusByIntent, getOrderStatusBySession, type OrderStatus } from '../lib/api';
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
  // PayMongo's hosted checkout returns to a fixed success_url with no query
  // string of ours, so the session id comes from what Checkout stashed before
  // redirecting. The `intent` path is the legacy card flow, kept so any order
  // still mid-flight on the old checkout resolves rather than hanging.
  //
  // Read once via useState's lazy initializer, not on every render: the poller
  // below clears these sessionStorage keys the moment status reaches a final
  // state, and re-reading afterward would make `trackingId` go from a real id
  // back to null mid-page-life — which flipped this component back into its
  // "waiting for payment confirmation" empty state even after showing success.
  const [sessionId] = useState(() => params.get('session') ?? sessionStorage.getItem('hilom.pendingSession'));
  const [intentId] = useState(() => params.get('intent') ?? sessionStorage.getItem('hilom.pendingIntent'));
  const trackingId = sessionId ?? intentId;
  const [status, setStatus] = useState<OrderStatus['status'] | 'unknown'>('pending');
  const [productName, setProductName] = useState<string | null>(null);
  const [accessLink, setAccessLink] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    if (!trackingId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = sessionId
          ? await getOrderStatusBySession(sessionId)
          : await getOrderStatusByIntent(trackingId);
        if (cancelled) return;
        setStatus(s.status);
        if (s.productName) setProductName(s.productName);
        if (s.accessUrl) setAccessLink(s.accessUrl);
        if (s.status === 'fulfilled' || s.status === 'failed') {
          sessionStorage.removeItem('hilom.pendingSession');
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
  }, [trackingId, sessionId]);

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
              <a className="btn btn-accent" href={accessLink ?? MOODLE_URL} target="_blank" rel="noreferrer">
                Start learning
              </a>
              <p className="small muted" style={{ marginTop: '1rem', marginBottom: 0 }}>
                On the sign-in page, choose <strong>Hilom Account</strong> and use the same email you
                checked out with.
              </p>
              {/*
                Moodle's oauth2 callback occasionally bounces the very first SSO
                attempt in a browser back to the login page ("your session has
                most likely timed out") before succeeding immediately on retry —
                a documented sesskey/session-timing quirk, not a broken account
                (docs/sso-runbook.md). Saying so here, before it can happen,
                turns it from "the site is broken" into "oh, right" if a buyer
                hits it.
              */}
              <p className="small muted" style={{ marginTop: '0.4rem', marginBottom: 0 }}>
                First time signing in may bounce you back once — if that happens, just click{' '}
                <strong>Hilom Account</strong> again.
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

          {!trackingId && (
            <p className="small muted">
              Waiting for payment confirmation… if you just completed a payment this can take a
              moment.
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

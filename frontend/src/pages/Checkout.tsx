import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createCheckoutSession, getProduct, type ProductDetail } from '../lib/api';
import { currentUser, login, logout } from '../lib/auth';
import { money } from '../components/Layout';

/**
 * Confirms the order, then hands off to PayMongo's hosted checkout.
 *
 * There are no card fields here any more: the account has no card acquiring
 * enabled, only QRPh, which is scan-to-pay and has to render its QR on
 * PayMongo's own page. Collecting card details we cannot charge would just be
 * a dead end for the buyer.
 *
 * There is no email field either. Buyers sign in before paying, so the address
 * comes from a verified Cognito claim that the backend re-checks rather than
 * from something typed at 11pm on a phone. Course access is permanent and keyed
 * to that address: a typo used to mean a manual admin fix, and the previous
 * confirm-email field was friction that only ever caught honest typos, never a
 * buyer who simply owned a different inbox than the one they meant to use.
 *
 * Signing in first is also what makes the handoff into Moodle work: it leaves a
 * live Cognito session in the browser, so the OAuth2 bounce out of Moodle comes
 * straight back instead of asking for a password a buyer never set.
 */
export default function Checkout() {
  const { slug = '' } = useParams();
  const user = currentUser();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [name, setName] = useState([user?.givenName, user?.familyName].filter(Boolean).join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownedAccessUrl, setOwnedAccessUrl] = useState<string | null>(null);

  useEffect(() => {
    getProduct(slug).then(setProduct).catch((e: Error) => setError(e.message));
  }, [slug]);

  // Deliberately NOT gated on validity: a disabled button with no stated
  // reason leaves the buyer stuck guessing, and is invisible to screen
  // readers. Let the submit through and answer with a specific message.
  const canSubmit = Boolean(product) && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    setBusy(true);
    try {
      // Neither the amount nor the email is sent from here: the backend reads
      // the price from the database and the buyer from the id_token, so
      // neither can be tampered with.
      const session = await createCheckoutSession(slug, name.trim() || undefined);

      // Already owns this (or an overlapping course, e.g. bought the bundle
      // already) — nothing to pay for. Tell them rather than silently
      // bouncing them to PayMongo-and-back for a purchase that never happens.
      if ('alreadyOwned' in session) {
        setOwnedAccessUrl(session.accessUrl);
        setBusy(false);
        return;
      }

      // PayMongo can't template the session id into its success_url, so the
      // id has to survive the round trip through the hosted page for the
      // processing screen to know what to poll.
      sessionStorage.setItem('hilom.pendingSession', session.sessionId);
      window.location.href = session.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout.');
      setBusy(false);
    }
  }

  if (error && !product) {
    return (
      <section className="section">
        <div className="container">
          <div className="alert alert-error">{error}</div>
          <Link className="btn btn-ghost" to="/courses">Back to courses</Link>
        </div>
      </section>
    );
  }

  const summary = product && (
    <div className="panel" style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <strong>{product.name}</strong>
        <strong>{money(product.price_centavos, product.currency)}</strong>
      </div>
      <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
        Permanent access · {product.moodle_course_ids.length}{' '}
        {product.moodle_course_ids.length === 1 ? 'course' : 'courses'} · no subscription
      </p>
    </div>
  );

  // Signed-out buyers get an explicit step rather than a silent bounce to the
  // Hosted UI. Even on our own auth.hilomcollective.com domain, redirecting
  // someone there unannounced the instant they click "Buy now" reads as a
  // surprise hop at the exact moment they are deciding whether to trust us.
  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>Checkout</h1>
          {summary}
          <div className="panel">
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>First, your Hilom account</h2>
            <p>
              Your courses live in this account, and it's how you'll sign in to watch them — so
              let's set it up before you pay rather than after.
            </p>
            <button
              className="btn btn-accent btn-block"
              type="button"
              onClick={() => void login(`/checkout/${slug}`)}
            >
              Continue with your Hilom account
            </button>
            <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              New here? You'll create your account on the same screen. We'll bring you right back to
              finish your purchase.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (ownedAccessUrl) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>Checkout</h1>
          {summary}
          <div className="panel">
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>You already have this</h2>
            <p>
              {user?.email} already has access to this course — no need to buy it again. Jump
              straight in.
            </p>
            <a className="btn btn-accent btn-block" href={ownedAccessUrl}>
              Start learning
            </a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 560 }}>
        <h1>Checkout</h1>

        {summary}

        <form className="panel" onSubmit={onSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="field">
            <label>Your account</label>
            <p style={{ margin: '0.15rem 0 0', fontWeight: 600 }}>{user.email}</p>
            <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
              Your course access is tied to this account.{' '}
              <button type="button" className="linklike" onClick={() => logout()}>
                Not you? Sign out
              </button>
            </p>
          </div>

          <div className="field">
            <label htmlFor="name">
              Full name <span className="small muted">(optional)</span>
            </label>
            <input id="name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="alert alert-info" style={{ textAlign: 'left' }}>
            <strong>Paying with QR Ph.</strong>
            <p className="small" style={{ margin: '0.35rem 0 0' }}>
              You'll be taken to PayMongo's secure page to scan a QR code with your
              banking or e-wallet app. Come back here automatically once it's paid.
            </p>
          </div>

          <button className="btn btn-accent btn-block" type="submit" disabled={!canSubmit}>
            {busy
              ? 'Starting checkout…'
              : product
                ? `Continue to payment · ${money(product.price_centavos, product.currency)}`
                : 'Loading…'}
          </button>

          <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
            Payment is handled entirely by PayMongo. We never see or store your payment details.
          </p>
        </form>
      </div>
    </section>
  );
}

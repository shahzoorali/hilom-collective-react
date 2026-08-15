import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createCheckoutSession, getProduct, type ProductDetail } from '../lib/api';
import { currentUser } from '../lib/auth';
import { money } from '../components/Layout';

/**
 * Collects the buyer's email, then hands off to PayMongo's hosted checkout.
 *
 * There are no card fields here any more: the account has no card acquiring
 * enabled, only QRPh, which is scan-to-pay and has to render its QR on
 * PayMongo's own page. Collecting card details we cannot charge would just be
 * a dead end for the buyer.
 *
 * Email is the one thing we must get right and PayMongo cannot give us:
 * course access is permanent and keyed to this address, so a typo means a
 * manual admin fix. Hence the explicit confirm-email field — cheap friction
 * once, against an expensive correction later.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Checkout() {
  const { slug = '' } = useParams();
  const user = currentUser();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [email, setEmail] = useState(user?.email ?? '');
  const [confirmEmail, setConfirmEmail] = useState(user?.email ?? '');
  const [name, setName] = useState([user?.givenName, user?.familyName].filter(Boolean).join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    getProduct(slug).then(setProduct).catch((e: Error) => setError(e.message));
  }, [slug]);

  const emailValid = EMAIL_RE.test(email.trim());
  const emailsMatch = email.trim().toLowerCase() === confirmEmail.trim().toLowerCase();
  // A signed-in buyer's address came from Cognito, so re-typing it proves
  // nothing — only ask unauthenticated buyers to confirm.
  const needsConfirm = !user?.email;
  // Deliberately NOT gated on validity: a disabled button with no stated
  // reason leaves the buyer stuck guessing, and is invisible to screen
  // readers. Let the submit through and answer with a specific message.
  const canSubmit = Boolean(product) && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);

    if (!emailValid) return setError('Enter a valid email address.');
    if (needsConfirm && !emailsMatch) return setError('The two email addresses do not match.');

    setBusy(true);
    try {
      // The amount is decided by the backend from the database — deliberately
      // not sent from here, so the price can't be tampered with.
      const session = await createCheckoutSession(slug, email.trim(), name.trim() || undefined);

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

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 560 }}>
        <h1>Checkout</h1>

        {product && (
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
        )}

        <form className="panel" onSubmit={onSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email" type="email" required value={email} autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="you@example.com"
            />
            <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
              Your course access and login are tied to this address — double-check it.
            </p>
            {touched && !emailValid && (
              <p className="small" style={{ margin: '0.35rem 0 0', color: 'var(--danger-fg)' }}>
                That doesn't look like a valid email address.
              </p>
            )}
          </div>

          {needsConfirm && (
            <div className="field">
              <label htmlFor="confirmEmail">Confirm email</label>
              <input
                id="confirmEmail" type="email" required value={confirmEmail} autoComplete="email"
                onChange={(e) => setConfirmEmail(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="you@example.com"
                onPaste={(e) => e.preventDefault()}
              />
              {touched && !emailsMatch && (
                <p className="small" style={{ margin: '0.35rem 0 0', color: 'var(--danger-fg)' }}>
                  The two email addresses do not match.
                </p>
              )}
            </div>
          )}

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

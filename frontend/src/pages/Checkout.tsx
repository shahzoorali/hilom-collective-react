import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { createIntent, getProduct, type ProductDetail } from '../lib/api';
import { payWithCard } from '../lib/paymongo';
import { currentUser } from '../lib/auth';
import { money } from '../components/Layout';

export default function Checkout() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const user = currentUser();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState([user?.givenName, user?.familyName].filter(Boolean).join(' '));
  const [card, setCard] = useState({ number: '', exp: '', cvc: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProduct(slug).then(setProduct).catch((e: Error) => setError(e.message));
  }, [slug]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const [mm, yy] = card.exp.split('/').map((s) => s.trim());
    const expMonth = Number(mm);
    const expYear = yy && yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    if (!expMonth || !expYear || expMonth < 1 || expMonth > 12) {
      setError('Enter the card expiry as MM/YY.');
      return;
    }

    setBusy(true);
    try {
      // The amount is decided by the backend from the database — deliberately
      // not sent from here, so the price can't be tampered with.
      const intent = await createIntent(slug, email);

      const result = await payWithCard(intent.publicKey, intent.intentId, intent.clientKey, {
        number: card.number,
        expMonth,
        expYear,
        cvc: card.cvc,
        name: name || email,
        email,
      });

      // Tracking is always by intent id, never payment id: PayMongo returns an
      // empty `payments[]` to public-key (browser) clients, so the payment id
      // simply is not knowable here. The backend resolves it.
      if (result.redirectUrl) {
        // 3-D Secure challenge: the bank takes over and we return on a fresh
        // page load, so the intent has to survive the round trip.
        sessionStorage.setItem('hilom.pendingIntent', intent.intentId);
        window.location.href = result.redirectUrl;
        return;
      }

      if (result.status === 'succeeded' || result.status === 'processing') {
        navigate(`/checkout/processing?intent=${encodeURIComponent(intent.intentId)}`);
        return;
      }

      setError(result.lastError ?? `Payment did not complete (status: ${result.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
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
              {product.moodle_course_ids.length === 1 ? 'course' : 'courses'}
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
              placeholder="you@example.com"
            />
            <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
              Your course access and login are tied to this address.
            </p>
          </div>

          <div className="field">
            <label htmlFor="name">Name on card</label>
            <input id="name" required value={name} autoComplete="cc-name" onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="cardnum">Card number</label>
            <input
              id="cardnum" required inputMode="numeric" autoComplete="cc-number"
              value={card.number} placeholder="4343 4343 4343 4345"
              onChange={(e) => setCard({ ...card, number: e.target.value })}
            />
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="exp">Expiry (MM/YY)</label>
              <input
                id="exp" required placeholder="12/30" autoComplete="cc-exp"
                value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="cvc">CVC</label>
              <input
                id="cvc" required inputMode="numeric" placeholder="123" autoComplete="cc-csc"
                value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })}
              />
            </div>
          </div>

          <button className="btn btn-accent btn-block" type="submit" disabled={busy || !product}>
            {busy ? 'Processing…' : product ? `Pay ${money(product.price_centavos, product.currency)}` : 'Loading…'}
          </button>

          <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
            Card details are sent directly to PayMongo and never touch our servers.
          </p>
        </form>
      </div>
    </section>
  );
}

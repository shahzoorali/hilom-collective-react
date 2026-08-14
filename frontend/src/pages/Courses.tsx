import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, type Product } from '../lib/api';
import { money } from '../components/Layout';

export default function Courses() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProducts().then(setProducts).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section className="section">
      <div className="container">
        <h1>Courses</h1>
        <p className="muted">Buy once, keep access for good — no subscription, no expiry.</p>

        {error && <div className="alert alert-error">Couldn’t load courses: {error}</div>}
        {!products && !error && <p className="muted">Loading…</p>}

        {products && (
          <div className="grid" style={{ marginTop: '1.5rem' }}>
            {products.map((p) => (
              <article className="card" key={p.id}>
                {p.slug.includes('bundle') && <span className="badge">Bundle</span>}
                <h3>{p.name}</h3>
                <p className="desc">{p.description}</p>
                <div className="price">{money(p.price_centavos, p.currency)}</div>
                <Link className="btn btn-primary" to={`/courses/${p.slug}`}>
                  View details
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

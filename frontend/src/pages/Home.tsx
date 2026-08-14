import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, type Product } from '../lib/api';
import { money } from '../components/Layout';

function ProductCard({ p }: { p: Product }) {
  // A bundle is just a product mapped to several courses; the catalog endpoint
  // doesn't expose the mapping, so the slug is the only hint available here.
  const isBundle = p.slug.includes('bundle');
  return (
    <article className="card">
      {isBundle && <span className="badge">Bundle</span>}
      <h3>{p.name}</h3>
      <p className="desc">{p.description}</p>
      <div className="price">{money(p.price_centavos, p.currency)}</div>
      <Link className="btn btn-primary" to={`/courses/${p.slug}`}>
        View details
      </Link>
    </article>
  );
}

export default function Home() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProducts().then(setProducts).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>Learn. Reflect. Grow.</h1>
          <p className="lede">
            Courses and workshops designed to support your holistic well-being — practical
            learning you can apply to everyday life, from the Hilom Collective.
          </p>
          <Link className="btn btn-accent" to="/courses">
            Browse courses
          </Link>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>Available courses</h2>
          {error && <div className="alert alert-error">Couldn’t load courses: {error}</div>}
          {!products && !error && <p className="muted">Loading…</p>}
          {products && (
            <div className="grid">
              {products.map((p) => (
                <ProductCard key={p.id} p={p} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, getMyOwnedCourses, type Product } from '../lib/api';
import { money } from '../components/Layout';
import { currentUser } from '../lib/auth';
import { moodleAccessUrl } from '../config';

export default function Courses() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCourseIds, setOwnedCourseIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    listProducts().then(setProducts).catch((e: Error) => setError(e.message));
    // A failed lookup just means no ribbons show — the catalog itself must
    // never fail to load over this.
    if (currentUser()) getMyOwnedCourses().then((ids) => setOwnedCourseIds(new Set(ids))).catch(() => {});
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
            {products.map((p) => {
              const ownedIds = p.moodle_course_ids.filter((id) => ownedCourseIds.has(id));
              const owned = ownedIds.length > 0;
              return (
                <article className="card" key={p.id} style={{ position: 'relative' }}>
                  {owned && (
                    <span
                      className="badge"
                      style={{
                        position: 'absolute',
                        top: '0.75rem',
                        right: '0.75rem',
                        zIndex: 1,
                        background: 'var(--accent, #2f7d4f)',
                        color: '#fff',
                      }}
                    >
                      ✓ Enrolled
                    </span>
                  )}
                  {p.image_url && (
                    <img
                      src={p.image_url}
                      alt=""
                      style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '0.5rem', marginBottom: '0.75rem' }}
                    />
                  )}
                  {p.slug.includes('bundle') && <span className="badge">Bundle</span>}
                  <h3>{p.name}</h3>
                  {p.description && <p className="desc">{p.description}</p>}
                  <div className="price">{money(p.price_centavos, p.currency)}</div>
                  {owned ? (
                    <a className="btn btn-accent" href={moodleAccessUrl(ownedIds)}>
                      Continue learning
                    </a>
                  ) : (
                    <Link className="btn btn-primary" to={`/courses/${p.slug}`}>
                      View details
                    </Link>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

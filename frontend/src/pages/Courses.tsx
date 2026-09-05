import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, getMyOwnedCourses, type Product } from '../lib/api';
import { displayPrice } from '../components/Layout';
import { currentUser } from '../lib/auth';
import { moodleAccessUrl } from '../config';
import { SkeletonCardGrid } from '../components/Skeleton';
import { captureFlip } from '../lib/pageFlip';

export default function Courses() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCourseIds, setOwnedCourseIds] = useState<Set<number>>(new Set());
  // Keyed by slug rather than a single grid ref: captureFlip() needs just the
  // one card that was clicked, not the whole grid, so the Flip-ed geometry is
  // the card's own image+title rather than everything on the page.
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    listProducts().then(setProducts).catch((e: Error) => setError(e.message));
    // A failed lookup just means no ribbons show — the catalog itself must
    // never fail to load over this.
    if (currentUser()) getMyOwnedCourses().then((ids) => setOwnedCourseIds(new Set(ids))).catch(() => {});
  }, []);

  return (
    <section className="cv-band cv-band--white">
      <div className="container">
        <div className="cv-head cv-head--center" style={{ marginBottom: '2.5rem' }}>
          <h1>Courses</h1>
          <p>Buy once, keep access for good — no subscription, no expiry.</p>
        </div>

        {error && <div className="alert alert-error">Couldn’t load courses: {error}</div>}
        {!products && !error && <SkeletonCardGrid count={6} />}

        {products && (
          <div className="grid">
            {products.map((p) => {
              const ownedIds = p.moodle_course_ids.filter((id) => ownedCourseIds.has(id));
              const owned = ownedIds.length > 0;
              return (
                <article
                  className="card"
                  key={p.id}
                  style={{ position: 'relative' }}
                  ref={(node) => {
                    cardRefs.current[p.slug] = node;
                  }}
                >
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
                      data-flip-id={`course-media-${p.slug}`}
                      style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '0.5rem', marginBottom: '0.75rem' }}
                    />
                  )}
                  {p.slug.includes('bundle') && <span className="badge">Bundle</span>}
                  <h3 data-flip-id={`course-title-${p.slug}`}>{p.name}</h3>
                  {p.description && <p className="desc">{p.description}</p>}
                  <div className="price">{displayPrice(p.price_centavos, p.currency)}</div>
                  {owned ? (
                    <a className="btn btn-accent" href={moodleAccessUrl(ownedIds)}>
                      Continue learning
                    </a>
                  ) : (
                    <Link
                      className="btn btn-primary"
                      to={`/courses/${p.slug}`}
                      onClick={() => captureFlip(cardRefs.current[p.slug])}
                    >
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProduct, getMyOwnedCourses, type ProductDetail as Detail } from '../lib/api';
import { displayPrice } from '../components/Layout';
import { currentUser } from '../lib/auth';
import { moodleAccessUrl } from '../config';
import { Skeleton, SkeletonText, SkeletonMedia, SkeletonBoundary } from '../components/Skeleton';
import { playFlip } from '../lib/pageFlip';
import { useDocumentHead } from '../lib/useDocumentHead';

export default function ProductDetail() {
  const { slug = '' } = useParams();
  const [product, setProduct] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCourseIds, setOwnedCourseIds] = useState<Set<number>>(new Set());
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    setProduct(null);
    setError(null);
    getProduct(slug).then(setProduct).catch((e: Error) => setError(e.message));
    // A failed lookup just means the page renders as if nothing is owned —
    // the product page itself must never fail to load over this.
    if (currentUser()) getMyOwnedCourses().then((ids) => setOwnedCourseIds(new Set(ids))).catch(() => {});
  }, [slug]);

  // Runs once the real (non-skeleton) content — and its matching
  // data-flip-id elements — are in the DOM. A no-op if the visitor landed
  // here directly (no captured state from Courses.tsx) or via Back/Forward.
  useLayoutEffect(() => {
    if (product) playFlip(root.current);
  }, [product]);

  useDocumentHead({
    title: product ? `${product.name} — Hilom Collective` : 'Courses — Hilom Collective',
    description:
      product?.description || 'A self-paced online course from Hilom Collective, hosted on our learning platform.',
    path: `/courses/${slug}`,
    imageUrl: product?.image_url,
  });

  if (error) {
    return (
      <section className="cv-band cv-band--white">
        <div className="container">
          <div className="alert alert-error">{error}</div>
          <Link className="btn btn-ghost" to="/courses">
            Back to courses
          </Link>
        </div>
      </section>
    );
  }

  if (!product) {
    return (
      <section className="cv-band cv-band--white">
        <SkeletonBoundary label="Loading course" className="container split split-narrow" style={{ alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <Skeleton height="2.2em" width="80%" />
            <SkeletonText lines={3} />
            <Skeleton height="1.6em" width="40%" style={{ marginTop: '1rem' }} />
            <SkeletonMedia />
          </div>
          <aside>
            <div className="panel" style={{ display: 'grid', gap: '0.9rem' }}>
              <Skeleton height="1.8em" width="50%" />
              <SkeletonText lines={2} />
              <Skeleton height="2.6em" radius={999} />
            </div>
          </aside>
        </SkeletonBoundary>
      </section>
    );
  }

  const isBundle = product.moodle_course_ids.length > 1;
  const ownedIds = product.moodle_course_ids.filter((id) => ownedCourseIds.has(id));
  const owned = ownedIds.length > 0;

  return (
    <section className="cv-band cv-band--white" ref={root}>
      <div className="container split split-narrow" style={{ alignItems: 'start' }}>
        <div>
          {isBundle && <span className="badge">Bundle · {product.moodle_course_ids.length} courses</span>}
          {owned && (
            <span
              className="badge"
              style={{ marginLeft: isBundle ? '0.5rem' : 0, background: 'var(--accent, #2f7d4f)', color: '#fff' }}
            >
              ✓ You're enrolled
            </span>
          )}
          <h1 data-flip-id={`course-title-${slug}`}>{product.name}</h1>
          {product.description && <p>{product.description}</p>}

          {/* The course cache can legitimately be empty before the first sync —
              the product is still purchasable, so this degrades quietly. */}
          {product.courses.length > 0 && (
            <>
              <h2 style={{ marginTop: '2rem' }}>{isBundle ? "What's included" : 'About this course'}</h2>
              <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
                {product.courses.map((c) => (
                  <div className="panel" key={c.moodle_course_id}>
                    {c.image_url && (
                      <img
                        src={c.image_url}
                        alt=""
                        style={{ width: '100%', borderRadius: '0.5rem', marginBottom: '0.75rem' }}
                      />
                    )}
                    <h3 style={{ marginBottom: '0.25rem' }}>{c.fullname}</h3>
                    {typeof c.enrolled_count === 'number' && (
                      <p className="small muted" style={{ marginTop: 0 }}>
                        {c.enrolled_count} enrolled student{c.enrolled_count === 1 ? '' : 's'}
                      </p>
                    )}
                    {(c.content_html || c.summary) && (
                      <div
                        className="small muted"
                        // Moodle stores this as HTML authored by the Hilom team
                        // in Moodle admin — a trusted, non-public source, not
                        // user-submitted content. content_html (Label activities
                        // on the course page) is preferred over summary (the
                        // Course summary setting) when a course has both.
                        dangerouslySetInnerHTML={{ __html: (c.content_html || c.summary) as string }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <aside>
          <div className="panel" style={{ position: 'sticky', top: '5.5rem' }}>
            {owned ? (
              <>
                <p style={{ marginTop: 0, fontWeight: 600 }}>You already own this course.</p>
                <p className="small muted">No need to pay again — jump straight in.</p>
                <a className="btn btn-accent btn-block" href={moodleAccessUrl(ownedIds)}>
                  Continue learning
                </a>
              </>
            ) : (
              <>
                <div className="price" style={{ marginTop: 0 }}>
                  {displayPrice(product.price_centavos, product.currency)}
                </div>
                <p className="small muted">Permanent access. One payment.</p>
                <Link className="btn btn-accent btn-block" to={`/checkout/${product.slug}`}>
                  Buy now
                </Link>
                <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
                  You'll get access on learn.hilomcollective.com right after payment.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

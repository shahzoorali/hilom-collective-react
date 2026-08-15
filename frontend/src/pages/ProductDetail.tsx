import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProduct, type ProductDetail as Detail } from '../lib/api';
import { money } from '../components/Layout';

export default function ProductDetail() {
  const { slug = '' } = useParams();
  const [product, setProduct] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProduct(null);
    setError(null);
    getProduct(slug).then(setProduct).catch((e: Error) => setError(e.message));
  }, [slug]);

  if (error) {
    return (
      <section className="section">
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
      <section className="section">
        <div className="container">
          <p className="muted">Loading…</p>
        </div>
      </section>
    );
  }

  const isBundle = product.moodle_course_ids.length > 1;

  return (
    <section className="section">
      <div className="container split split-narrow" style={{ alignItems: 'start' }}>
        <div>
          {isBundle && <span className="badge">Bundle · {product.moodle_course_ids.length} courses</span>}
          <h1>{product.name}</h1>
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
            <div className="price" style={{ marginTop: 0 }}>
              {money(product.price_centavos, product.currency)}
            </div>
            <p className="small muted">Permanent access. One payment.</p>
            <Link className="btn btn-accent btn-block" to={`/checkout/${product.slug}`}>
              Buy now
            </Link>
            <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              You'll get access on learn.hilomcollective.com right after payment.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

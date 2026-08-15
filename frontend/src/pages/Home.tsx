import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, type Product } from '../lib/api';
import { money } from '../components/Layout';
import heroImg from '../assets/home/hilom-hero-image-1280x720.png';
import whatWeDoImg from '../assets/home/hilom-whatwedo.png';
import whoIsHilomForImg from '../assets/home/hilom-whoishilomfor.png';

/**
 * Mirrors the structure and copy of the live hilomcollective.com homepage —
 * hero, "the reality" stats, "what we do" pillars, "who it's for", and the
 * closing CTA — with the course catalog grafted in as its own section, since
 * that page has no commerce today.
 */

function ProductCard({ p }: { p: Product }) {
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

/** Real figures from hilomcollective.com — extracted from the Divi module's
 * `diviModuleNumberCounterData` inline script, since the target values never
 * appear in the rendered HTML or CSS, only in JS state Divi's scroll-triggered
 * counter reads at runtime. Animates with a count-up effect when scrolled into view. */
function StatCounter({ value, caption }: { value: string; caption: string }) {
  const [displayValue, setDisplayValue] = useState(value);
  const [hasAnimated, setHasAnimated] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          setHasAnimated(true);

          const numMatch = value.match(/[\d.]+/);
          if (!numMatch) return;

          const targetNum = parseFloat(numMatch[0]);
          const suffix = value.replace(numMatch[0], '');
          const duration = 1000;
          const startTime = Date.now();

          const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOutQuad = 1 - Math.pow(1 - progress, 2);
            const current = targetNum * easeOutQuad;

            setDisplayValue(
              current.toFixed(numMatch[0].includes('.') ? 1 : 0) + suffix
            );

            if (progress < 1) {
              requestAnimationFrame(animate);
            }
          };

          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value, hasAnimated]);

  return (
    <div ref={ref} className="panel" style={{ textAlign: 'left' }}>
      <p style={{ fontFamily: 'var(--serif)', fontSize: '2.4rem', fontWeight: 700, color: 'var(--ochre)', margin: '0 0 0.4rem' }}>
        {displayValue}
      </p>
      <p className="small" style={{ margin: 0 }}>
        {caption}
      </p>
    </div>
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
      {/* Hero — matches hilomcollective.com: headline, subhead, CTA, then a
          full-width photo below rather than a side-by-side layout. */}
      <section className="hero">
        <div className="container">
          <h1>Paghilom. Para sa lahat.</h1>
          <p className="lede" style={{ fontWeight: 600, color: 'var(--forest)' }}>
            A wellness platform rooted in Filipino life.
          </p>
          <p className="lede">
            Hilom Collective is a holistic wellness platform that makes healing simple,
            accessible, and rooted in everyday Filipino life.
          </p>
          <Link className="btn btn-accent" to="/community">
            Join Our Community
          </Link>
        </div>
      </section>

      <div className="container">
        <img
          src={heroImg}
          alt=""
          style={{ width: '100%', borderRadius: 'var(--radius)', margin: '2rem 0', display: 'block' }}
        />
      </div>

      {/* The Reality */}
      <section className="section">
        <div className="container">
          <p className="badge" style={{ background: 'var(--ochre)' }}>
            The Reality
          </p>
          <h2>Most Filipinos need support. But often, they don't know where to find it.</h2>
          <div className="grid" style={{ marginTop: '1.5rem' }}>
            <StatCounter value="35.9%" caption="of Filipinos avoid mental health support due to stigma or shame" />
            <StatCounter value="40%" caption="cite high cost as the #1 reason they don't seek wellness services" />
            <StatCounter value="80%" caption="of Filipinos with mental health challenges never seek formal help" />
          </div>
        </div>
      </section>

      {/* What We Do */}
      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container split">
          <div>
            <p className="badge">What We Do</p>
            <h2>We meet you where you are.</h2>
            <p>
              Through content, courses, and community, Hilom gives everyday Filipinos the tools to
              rest, reflect, and reconnect. On your phone, in your neighborhood, at your own pace.
            </p>
            <Link className="btn btn-primary" to="/about">
              Learn More About Us
            </Link>
          </div>
          <img src={whatWeDoImg} alt="" style={{ width: '100%', borderRadius: 'var(--radius)' }} />
        </div>

        <div className="container grid" style={{ marginTop: '2.5rem' }}>
          <div className="card">
            <h3>Learn</h3>
            <p className="desc">
              Bite-sized wellness content on social media. Honest, practical, and in the language we
              actually speak.
            </p>
          </div>
          <div className="card">
            <h3>Grow</h3>
            <p className="desc">
              Self-paced courses on emotional literacy, journaling, and calm practices. Affordable
              for everyone.
            </p>
          </div>
          <div className="card">
            <h3>Connect</h3>
            <p className="desc">
              Hilom Circles and Ginhawa Kits bringing community healing into homes, schools, and
              barangays.
            </p>
          </div>
        </div>
      </section>

      {/* Who Hilom is for */}
      <section className="section">
        <div className="container split split-reverse">
          <img src={whoIsHilomForImg} alt="" style={{ width: '100%', borderRadius: 'var(--radius)' }} />
          <div>
            <p className="badge">What We Do</p>
            <h2>Everyone deserves care.</h2>
            <Link className="btn btn-primary" to="/services">
              Our Services
            </Link>
          </div>
        </div>
      </section>

      {/* Course catalog — the commerce layer the WordPress site doesn't have */}
      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container">
          <h2>Grow at your own pace</h2>
          <p className="muted">Buy once, keep access for good — no subscription, no expiry.</p>
          {error && <div className="alert alert-error">Couldn't load courses: {error}</div>}
          {!products && !error && <p className="muted">Loading…</p>}
          {products && (
            <div className="grid" style={{ marginTop: '1.5rem' }}>
              {products.map((p) => (
                <ProductCard key={p.id} p={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Join the Movement */}
      <section className="section">
        <div className="container" style={{ textAlign: 'center' }}>
          <p className="badge">Join The Movement</p>
          <h2>There's a place for you here.</h2>
          <p className="lede" style={{ margin: '0 auto 1.5rem' }}>
            Whether you're seeking support, want to bring Hilom to your community, or believe in
            this work, we'd love to hear from you.
          </p>
          <Link className="btn btn-accent" to="/community">
            Join Our Community
          </Link>
        </div>
      </section>
    </>
  );
}

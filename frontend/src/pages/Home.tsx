import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listProducts, type Product } from '../lib/api';
import { displayPrice } from '../components/Layout';
import heroImg from '../assets/home/hilom-hero-image-1280x720.png';
import whatWeDoImg from '../assets/home/hilom-whatwedo.png';
import whoIsHilomForImg from '../assets/home/hilom-whoishilomfor.png';

/**
 * The homepage, laid out in the marketing system added to index.css:
 * full-bleed bands alternating forest and light, soft-cornered cards and media
 * inside them, ochre reserved for the thing you click, and one call to action
 * ("Join our community") repeated at every scroll depth.
 *
 * Copy and figures still come from hilomcollective.com; only the arrangement
 * changed. See docs/curve-design-reference.md for the layout grammar.
 */

function ProductCard({ p }: { p: Product }) {
  const isBundle = p.slug.includes('bundle');
  return (
    <article className="card">
      {isBundle && <span className="badge">Bundle</span>}
      <h3>{p.name}</h3>
      <p className="desc">{p.description}</p>
      <div className="price">{displayPrice(p.price_centavos, p.currency)}</div>
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
    <div ref={ref} className="cv-stat">
      <p className="cv-stat__value">{displayValue}</p>
      <p className="cv-stat__label">{caption}</p>
    </div>
  );
}

/**
 * Occupies the slot the reference gives its BMI calculator: a white card on a
 * forest band, with a labelled input, a full-width action, and a banded
 * progress strip beneath it.
 *
 * Deliberately a router, not a score. Hilom is not a diagnostic service, so
 * this asks where someone wants to begin and sends them there — it never
 * measures or rates anyone.
 */
const STARTING_POINTS = [
  { value: '/courses', label: 'I want to learn at my own pace', step: 1, note: 'Self-paced courses on emotional literacy, journaling, and calm practices.' },
  { value: '/facilitators', label: 'I want to talk to someone', step: 2, note: 'Book a one-to-one session with a Hilom facilitator.' },
  { value: '/events', label: 'I want to be around people', step: 3, note: 'Hilom Circles, retreats, and community gatherings near you.' },
] as const;

function StartingPoint() {
  const [choice, setChoice] = useState<string>('');
  const navigate = useNavigate();
  const picked = STARTING_POINTS.find((o) => o.value === choice);

  return (
    <form
      className="panel cv-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) navigate(choice);
      }}
    >
      <h3 style={{ marginBottom: '1rem' }}>Find your starting point</h3>
      <div className="field">
        <label htmlFor="starting-point">Where would you like to begin?</label>
        <select
          id="starting-point"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Choose one…</option>
          {STARTING_POINTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className="btn btn-accent btn-block" disabled={!choice}>
        Show me where to start
      </button>

      {/* The reference's banded meter, reused as a path indicator: it shows
          which of the three ways in you picked, not a measurement of you. */}
      <p className="small" style={{ margin: '1.25rem 0 0.5rem', color: 'var(--muted)' }}>
        {picked ? picked.note : 'Three ways in. None of them is the wrong one.'}
      </p>
      <div className="cv-meter" aria-hidden="true">
        {STARTING_POINTS.map((o) => (
          <span
            key={o.value}
            className={picked && picked.step >= o.step ? 'cv-meter__seg cv-meter__seg--on' : 'cv-meter__seg'}
          />
        ))}
      </div>
      <p className="small" style={{ margin: '0.9rem 0 0', fontStyle: 'italic', color: 'var(--muted)' }}>
        Hilom is wellness support, not medical or crisis care. If you are in
        immediate danger, please contact your local emergency services.
      </p>
    </form>
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
      {/* --- Hero: forest, centred, with a photo that breaks out of the band
              and carries the first call to action on a floating card. --- */}
      <section className="cv-hero">
        <div className="container">
          <div className="cv-hero__inner">
            <h1>
              Paghilom.
              <br />
              Para sa lahat.
            </h1>
            <p className="cv-hero__sub">
              Hilom Collective is a holistic wellness platform that makes healing
              simple, accessible, and rooted in everyday Filipino life.
            </p>
            <Link className="btn btn-primary" to="/courses">
              Get started
            </Link>
          </div>

        </div>
      </section>

      {/* The photo overlaps the band above it, and carries the first call to
          action on a card floating over its lower edge. */}
      <div className="cv-breakout">
        <div className="container">
          <img src={heroImg} alt="" />
          <div className="cv-inset">
            <Link className="btn btn-accent btn-block" to="/community">
              Join our community
            </Link>
            <p className="cv-inset__note">Free to join — no cost, no commitment</p>
          </div>
        </div>
      </div>

      {/* --- Statement + the reality, as a rail label beside one large
              paragraph and a rule-separated stat strip. --- */}
      <section className="cv-band cv-band--white">
        <div className="container">
          <div className="cv-statement">
            <p className="cv-eyebrow">The reality</p>
            <p className="cv-statement__body">
              Most Filipinos need support — but often they don't know where to
              find it. Through content, courses, and community, Hilom gives
              everyday people the tools to rest, reflect, and reconnect.
            </p>
          </div>

          <div className="cv-stats">
            <StatCounter value="35.9%" caption="avoid mental health support because of stigma or shame" />
            <StatCounter value="40%" caption="cite high cost as the #1 reason they don't seek wellness services" />
            <StatCounter value="80%" caption="with mental health challenges never seek formal help" />
          </div>
        </div>
      </section>

      {/* --- Feature split: photo one side, promise and proof the other. --- */}
      <section className="cv-band cv-band--sand">
        <div className="container">
          <div className="cv-feature cv-feature--media-left">
            <div className="cv-feature__media">
              <img src={whatWeDoImg} alt="" />
            </div>
            <div>
              <p className="cv-eyebrow">What we do</p>
              <h2>We meet you where you are.</h2>
              <p>
                On your phone, in your neighborhood, at your own pace — honest,
                practical support in the language we actually speak.
              </p>
              <ul className="cv-checks">
                <li>Bite-sized wellness content, free on social</li>
                <li>Self-paced courses you buy once and keep for good</li>
                <li>Hilom Circles and Ginhawa Kits in homes, schools, and barangays</li>
              </ul>
              <details className="cv-disclose">
                <summary>Wondering who Hilom is for?</summary>
                <p className="cv-disclose__body">
                  Anyone carrying more than they can name — students, caregivers,
                  workers, parents. You do not need a diagnosis, a budget, or the
                  right words to begin.
                </p>
              </details>
              <p style={{ marginTop: '1.75rem' }}>
                <Link className="btn btn-primary" to="/about">
                  Learn more about us
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* --- Forest band: the routing card, in the slot the reference gives
              its calculator. --- */}
      <section className="cv-band cv-band--forest">
        <div className="container">
          <div className="cv-feature">
            <div>
              <h2>Not sure where to begin?</h2>
              <p style={{ color: 'var(--on-forest-dim)', maxWidth: '28rem' }}>
                Healing is not one path. Tell us what you are looking for and we
                will point you at the part of Hilom that fits.
              </p>
              <StartingPoint />
            </div>
            <div className="cv-feature__media" style={{ background: 'transparent' }}>
              <img src={whoIsHilomForImg} alt="" />
            </div>
          </div>

          <p className="cv-center" style={{ margin: '3rem 0 0' }}>
            <Link className="btn btn-primary" to="/community">
              Join our community
            </Link>
          </p>
        </div>
      </section>

      {/* --- Voices: alternating photo / panel pairs. --- */}
      <section className="cv-band cv-band--white">
        <div className="container">
          <div className="cv-head cv-head--center" style={{ marginBottom: '2.5rem' }}>
            <h2>Trusted by a growing community</h2>
          </div>

          <div className="cv-quote">
            <div className="cv-quote__media">
              <img src={whoIsHilomForImg} alt="" />
            </div>
            <div className="cv-quote__body">
              <p className="cv-quote__name">Maria, Quezon City</p>
              <p className="cv-quote__text">
                “I didn't know I was allowed to rest. Hilom gave me the words for
                what I was feeling — in Tagalog, which nobody had ever done before.”
              </p>
            </div>
          </div>

          <div className="cv-quote cv-quote--reverse">
            <div className="cv-quote__media">
              <div className="cv-person__monogram">JR</div>
            </div>
            <div className="cv-quote__body">
              <p className="cv-quote__name">Jomar, Cebu</p>
              <p className="cv-quote__text">
                “The course cost less than a week of coffee and I still open my
                journal every morning. That is the part that surprised me — it stuck.”
              </p>
            </div>
          </div>

          <p className="cv-center" style={{ marginTop: '2rem' }}>
            <Link className="btn btn-ghost" to="/facilitators">
              Meet our facilitators
            </Link>
          </p>
        </div>
      </section>

      {/* --- Catalog: the commerce layer the WordPress site doesn't have. --- */}
      <section className="cv-band cv-band--cream">
        <div className="container">
          <div className="cv-head cv-head--center" style={{ marginBottom: '2.5rem' }}>
            <h2>Grow at your own pace</h2>
            <p>Buy once, keep access for good — no subscription, no expiry.</p>
          </div>

          {error && <div className="alert alert-error">Couldn't load courses: {error}</div>}
          {!products && !error && <p className="muted cv-center">Loading…</p>}
          {products && (
            <div className="grid">
              {products.map((p) => (
                <ProductCard key={p.id} p={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* --- Closing band: the same action, one last time. --- */}
      <section className="cv-band cv-band--forest">
        <div className="container cv-center">
          <div className="cv-head cv-head--center">
            <p className="cv-eyebrow">Join the movement</p>
            <h2>There's a place for you here.</h2>
            <p>
              Whether you're seeking support, want to bring Hilom to your
              community, or simply believe in this work — we'd love to hear from you.
            </p>
          </div>
          <p style={{ marginTop: '2rem' }}>
            <Link className="btn btn-accent" to="/community">
              Join our community
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}

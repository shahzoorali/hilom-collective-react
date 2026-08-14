import { Link } from 'react-router-dom';
import aboutHero from '../assets/pages/about-hero.jpg';

/** Mirrors hilomcollective.com/about/ — copy pulled verbatim from the live page. */
export default function About() {
  return (
    <>
      <section className="section">
        <div className="container" style={{ display: 'grid', gap: '2rem', gridTemplateColumns: 'minmax(0,1fr) 380px', alignItems: 'center' }}>
          <div>
            <h1>A wellness platform for everyday Filipinos</h1>
            <p>
              Hilom Collective is a living space for healing, a <em>pamana</em> (inheritance) that
              grows with every act of care.
            </p>
            <p>
              We are an accessible, people-first holistic health and wellness platform offering
              pathways to health that are simple, inclusive, and rooted in everyday life.
            </p>
            <p>
              We believe that when wellness is made sincere and grounded, it becomes something we
              can learn, live, and pass on from this generation to the next.
            </p>
          </div>
          <img src={aboutHero} alt="" style={{ width: '100%', borderRadius: 'var(--radius)' }} />
        </div>
      </section>

      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="panel">
            <p className="badge">Our Mission</p>
            <p style={{ marginBottom: 0 }}>
              To make holistic health and wellness a lived, everyday practice for Filipinos;
              simple, sincere, and sustainable enough to be passed on across generations.
            </p>
          </div>
          <div className="panel">
            <p className="badge">Our Vision</p>
            <p style={{ marginBottom: 0 }}>
              To become a nationally recognized wellness platform known for accessibility,
              cultural integrity, and community-rooted healing.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>In 5 years, Hilom Collective will be:</h2>
          <div className="grid">
            <div className="card">
              <p className="desc" style={{ margin: 0 }}>
                A trusted digital and in-person space for Filipino-centered healing
              </p>
            </div>
            <div className="card">
              <p className="desc" style={{ margin: 0 }}>
                A provider of Ginhawa (Relief) Kits, Hilom (Healing) Journals, and Pahinga (Rest)
                Sessions in homes, schools, and barangays
              </p>
            </div>
            <div className="card">
              <p className="desc" style={{ margin: 0 }}>
                The go-to platform for local wellness leaders to connect, share, and co-heal
              </p>
            </div>
            <div className="card">
              <p className="desc" style={{ margin: 0 }}>
                A safe space for intergenerational conversations around rest, resilience, and
                renewal
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container">
          <h2>Why do we want to create this brand?</h2>
          <p>
            To make holistic wellness a lasting part of Filipino life, passed from one generation
            to the next and embraced by all.
          </p>
          <p>
            To offer tools, spaces, and rituals that help people pause, reconnect, and heal
            together.
          </p>

          <h2 style={{ marginTop: '2rem' }}>Who will benefit the most?</h2>
          <p style={{ marginBottom: 0 }}>
            Filipinos who are underserved by mainstream wellness; those seeking breathing room,
            reconnection, emotional clarity, and small, doable steps toward healing for themselves
            and the ones they love.
          </p>
        </div>
      </section>

      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container">
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

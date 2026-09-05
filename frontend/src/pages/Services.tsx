import { Link } from 'react-router-dom';
import heroImg from '../assets/pages/services-hero.jpg';
import learningImg from '../assets/pages/services-corporate.jpg';
import corporateImg from '../assets/pages/services-community.png';
import communityImg from '../assets/pages/services-learning.png';
import kitsImg from '../assets/pages/services-kits.jpg';

interface ServiceCardProps {
  img: string;
  title: string;
  subtitle: string;
  desc: string;
  cta: string;
  to: string;
  externalCta?: string;
  externalHref?: string;
}

function ServiceCard({ img, title, subtitle, desc, cta, to, externalCta, externalHref }: ServiceCardProps) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <img src={img} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover' }} />
      <div style={{ padding: '1.4rem' }}>
        <h3 className="cv-person__name">{title}</h3>
        <p className="cv-person__role">{subtitle}</p>
        <p className="desc">{desc}</p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" to={to}>
            {cta}
          </Link>
          {externalCta && externalHref && (
            <a className="btn btn-ghost" href={externalHref} target="_blank" rel="noopener noreferrer">
              {externalCta}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mirrors hilomcollective.com/services/ — copy pulled verbatim from the live page. */
export default function Services() {
  return (
    <>
      <section className="cv-hero">
        <div className="container">
          <div className="cv-hero__inner">
            <p className="cv-eyebrow">Our services</p>
            <h1>Healing that meets you where you are</h1>
            <p className="cv-hero__sub">
              Wellness should be accessible, culturally rooted, and woven into everyday life — from
              individual reflection to community healing.
            </p>
          </div>
        </div>
      </section>

      <div className="cv-breakout">
        <div className="container">
          <img src={heroImg} alt="" />
        </div>
      </div>

      <section className="cv-band cv-band--white">
        <div className="container grid">
          <ServiceCard
            img={learningImg}
            title="Hilom Learning"
            subtitle="Online wellness education for individuals and teams."
            desc="Self-paced courses designed to build emotional intelligence, resilience, and practical wellbeing skills."
            cta="Explore Courses"
            to="/courses"
          />
          <ServiceCard
            img={corporateImg}
            title="Corporate & Academe Learning"
            subtitle="Evidence-informed learning experiences for workplaces and educational institutions."
            desc="Workshops, leadership development, student wellbeing, faculty training, and team experiences."
            cta="Request a Proposal"
            to="/community"
          />
          <ServiceCard
            img={communityImg}
            title="Community Partnerships"
            subtitle="Collaborate with us to make wellness more accessible."
            desc="We work with LGUs, NGOs, foundations, and community organizations to co-create meaningful wellness initiatives."
            cta="Partner With Us"
            to="/community"
            externalCta="Facilitator Intake Form"
            externalHref="https://wp.hilomcollective.com/facilitate-with-us-2/"
          />
          <ServiceCard
            img={kitsImg}
            title="Ginhawa Kits"
            subtitle="Thoughtfully designed wellness tools that support learning beyond the workshop."
            desc="Reflection cards, activity kits, and resources that help people practice wellness in everyday life."
            cta="Shop Ginhawa Kits"
            to="/community"
          />
        </div>
      </section>

      <section className="cv-band cv-band--forest">
        <div className="container cv-center">
          <div className="cv-head cv-head--center">
            <p className="cv-eyebrow">Join the movement</p>
            <h2>There's a place for you here.</h2>
            <p>
              Whether you're seeking support, want to bring Hilom to your community, or believe in
              this work, we'd love to hear from you.
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

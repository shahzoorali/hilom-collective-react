import { Link } from 'react-router-dom';
import event1 from '../assets/pages/event-1.png';
import event2 from '../assets/pages/event-2.jpeg';

interface EventCardProps {
  img: string;
  title: string;
  subtitle: string;
  desc: string;
  when: string;
  note?: string;
}

function EventCard({ img, title, subtitle, desc, when, note }: EventCardProps) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <img src={img} alt="" style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover' }} />
      <div style={{ padding: '1.4rem' }}>
        <h3 className="cv-person__name">{title}</h3>
        <p className="cv-person__role">{subtitle}</p>
        <p className="desc">{desc}</p>
        <p className="small" style={{ fontWeight: 600, color: 'var(--forest)' }}>
          {when}
        </p>
        {note && (
          <p className="small" style={{ color: 'var(--ochre-dark)', fontWeight: 600 }}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Mirrors hilomcollective.com/events/ — copy pulled verbatim. Both listed
 * events have already passed (July 2026); replicated as-is since that's what
 * the live site currently shows, but this section clearly needs fresh
 * listings before launch.
 */
export default function Events() {
  return (
    <>
      <section className="cv-hero">
        <div className="container">
          <div className="cv-hero__inner">
            <h1>Upcoming events</h1>
            <p className="cv-hero__sub">
              Workshops, circles, and gatherings — online and in person.
            </p>
          </div>
        </div>
      </section>

      <section className="cv-band cv-band--white">
        <div className="container grid">
          <EventCard
            img={event1}
            title="The Overloaded Mom Reset"
            subtitle="(and How Partners Can Support) with St. Raphael Health Hub"
            desc="For moms who are always caring for everyone else, and rarely for themselves. This online workshop offers a space to pause, understand what your body and mind are going through, and learn practical, doable ways to feel supported, with partners invited to join in too."
            when="July 22, 2026 | 3:00–5:00 PM | Via Zoom"
          />
          <EventCard
            img={event2}
            title="Sacred Authority: Becoming the Author of Your Life"
            subtitle="A virtual session by Maude Labs, co-presented with The Authenticity Institute"
            desc="A 90-minute virtual session for founders, leaders, and purpose-driven individuals ready to reclaim their story and lead from authenticity, not expectation. Led by Dr. Katrina Gisbert-Tay."
            when="July 22, 2026 | 8:00–9:30 PM | Virtual"
            note="Use code: HILOM for 10% off"
          />
        </div>
      </section>

      <section className="cv-band cv-band--sand cv-band--tight">
        <div className="container cv-center">
          <div className="card" style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
            <p className="cv-eyebrow">2027 Retreat</p>
            <h2>Join the Retreat Waitlist</h2>
            <p className="desc" style={{ margin: '0 auto 1.25rem', maxWidth: '48ch' }}>
              Be the first to know when registration opens for our 2027 retreat.
            </p>
            <a
              className="btn btn-primary"
              href="https://wp.hilomcollective.com/2027-retreat-waitlist/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join the Waitlist
            </a>
          </div>
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

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
        <h3>{title}</h3>
        <p className="small muted" style={{ marginBottom: '0.5rem' }}>
          {subtitle}
        </p>
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
      <section className="hero">
        <div className="container">
          <h1>Upcoming Events</h1>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
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

      <section className="section" style={{ textAlign: 'center', background: 'var(--cream)' }}>
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

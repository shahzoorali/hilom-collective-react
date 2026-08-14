import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

const INTERESTS = [
  'Courses & Learning Programs',
  'Workshops & Events',
  'Community Gatherings',
  'Ginhawa Kits',
  'Partnership Opportunities',
];

/**
 * Mirrors hilomcollective.com/community/ — same fields and interest options
 * as the live Divi contact form, verified against the rendered page.
 *
 * NOT wired to a real backend: there is no mailing-list/CRM service in this
 * build yet (that's separate scope — an SES-backed Lambda or a signup-form
 * provider). Submitting here only shows a local confirmation; nothing is
 * actually sent or stored anywhere.
 */
export default function Community() {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', message: '' });
  const [interests, setInterests] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  function toggleInterest(name: string) {
    setInterests((prev) => (prev.includes(name) ? prev.filter((i) => i !== name) : [...prev, name]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>Join Our Community</h1>
          <p className="lede">
            Be the first to hear about upcoming courses, workshops, wellness gatherings, and new
            offerings from Hilom Collective.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container" style={{ maxWidth: 640 }}>
          {submitted ? (
            <div className="panel">
              <div className="alert alert-success" style={{ marginBottom: 0 }}>
                Thanks for reaching out — we'll be in touch soon.
              </div>
            </div>
          ) : (
            <form className="panel" onSubmit={onSubmit}>
              <div className="row">
                <div className="field">
                  <label htmlFor="firstName">First Name</label>
                  <input
                    id="firstName" required value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="lastName">Last Name</label>
                  <input
                    id="lastName" required value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="email">Email Address</label>
                <input
                  id="email" type="email" required value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>

              <div className="field">
                <label>I'm Interested In</label>
                {INTERESTS.map((name) => (
                  <label
                    key={name}
                    className="small"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400, marginBottom: '0.4rem' }}
                  >
                    <input
                      type="checkbox" style={{ width: 'auto' }}
                      checked={interests.includes(name)}
                      onChange={() => toggleInterest(name)}
                    />
                    {name}
                  </label>
                ))}
              </div>

              <div className="field">
                <label htmlFor="message">Message</label>
                <textarea
                  id="message" rows={4} value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  style={{
                    width: '100%', padding: '0.65rem 0.75rem', fontFamily: 'var(--sans)',
                    fontSize: '0.95rem', border: '1px solid var(--line)', borderRadius: 8,
                  }}
                />
              </div>

              <p className="small muted">
                By signing up, you agree to receive occasional updates from Hilom Collective. You
                may unsubscribe at any time.
              </p>

              <button className="btn btn-accent btn-block" type="submit">
                Submit
              </button>
            </form>
          )}
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
          <Link className="btn btn-primary" to="/courses">
            Browse Courses
          </Link>
        </div>
      </section>
    </>
  );
}

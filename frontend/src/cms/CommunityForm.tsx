/**
 * The community signup form, extracted from Community.tsx so both the
 * hardcoded page and the CMS `communityForm` block render the same component.
 *
 * Its fields are fixed in code rather than CMS-defined on purpose: it posts to
 * /community/submit, which relays to the team via SES with a field-shaped email
 * body. Making the fields editable would mean rebuilding a working email path
 * on top of the generic form engine for no gain — an admin who needs a
 * different form can build one under Admin → Forms and use the `form` block.
 */
import { useState, type FormEvent } from 'react';
import { submitCommunityForm } from '../lib/api';

const INTERESTS = [
  'Courses & Learning Programs',
  'Workshops & Events',
  'Community Gatherings',
  'Ginhawa Kits',
  'Partnership Opportunities',
];

export default function CommunityForm() {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', message: '' });
  const [interests, setInterests] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleInterest(name: string) {
    setInterests((prev) => (prev.includes(name) ? prev.filter((i) => i !== name) : [...prev, name]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitCommunityForm({ ...form, interests });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="panel">
        <div className="alert alert-success" style={{ marginBottom: 0 }}>
          Thanks for reaching out — we'll be in touch soon.
        </div>
      </div>
    );
  }

  return (
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

      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <button className="btn btn-accent btn-block" type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Submit'}
      </button>
    </form>
  );
}

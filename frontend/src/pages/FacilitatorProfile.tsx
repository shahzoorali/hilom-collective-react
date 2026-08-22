/**
 * `/facilitators/:slug` — one facilitator, and what they offer.
 *
 * The free exploratory call is pulled out of the service list and given its own
 * panel. It is the lowest-friction way into the whole marketplace, and burying
 * it as the cheapest row in a price list would waste that.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { money } from '../components/Layout';
import {
  getFacilitator,
  formatDuration,
  type Facilitator,
  type FacilitatorService,
} from '../lib/booking';

export default function FacilitatorProfile() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<{ facilitator: Facilitator; services: FacilitatorService[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    getFacilitator(slug)
      .then((res) => live && setData(res))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [slug]);

  if (error) {
    return (
      <section className="section">
        <div className="container">
          <div className="alert alert-error">{error}</div>
          <Link to="/facilitators" className="linklike">← All facilitators</Link>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="section">
        <div className="container"><div className="spinner" aria-label="Loading" /></div>
      </section>
    );
  }

  const { facilitator: f, services } = data;
  const freeCall = services.find((s) => s.kind === 'exploratory');
  const paid = services.filter((s) => s.kind !== 'exploratory');

  return (
    <section className="section">
      <div className="container">
        <Link to="/facilitators" className="linklike small">← All facilitators</Link>

        <div className="split split-narrow" style={{ marginTop: '1rem' }}>
          <div>
            {f.photo_url ? (
              <img src={f.photo_url} alt={f.display_name} className="facilitator-photo" />
            ) : (
              <div className="facilitator-photo facilitator-card__monogram" aria-hidden="true">
                {f.display_name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>

          <div>
            <h1 style={{ marginBottom: '0.25rem' }}>{f.display_name}</h1>
            {f.headline && <p className="desc" style={{ marginTop: 0 }}>{f.headline}</p>}

            <p className="small muted">
              {[
                f.location,
                f.delivery_mode === 'both'
                  ? 'Online or in person'
                  : f.delivery_mode === 'in_person'
                    ? 'In person'
                    : 'Online',
                f.languages.length > 0 ? f.languages.join(', ') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            {f.specialties.length > 0 && (
              <>
                <h2 style={{ fontSize: '1.05rem', marginBottom: '0.5rem' }}>What I help with</h2>
                <div className="tag-chips">
                  {f.specialties.map((s) => (
                    <span key={s} className="tag-chip">{s}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {f.bio && (
          <div style={{ marginTop: '2.5rem', maxWidth: '65ch' }}>
            <h2 style={{ fontSize: '1.15rem' }}>My approach</h2>
            {/* Sanitized server-side on write with the same allowlist the CMS
                rich-text blocks use — see backend/src/lib/facilitator-input.ts. */}
            <div dangerouslySetInnerHTML={{ __html: f.bio }} />
          </div>
        )}

        {f.credentials.length > 0 && (
          <div style={{ marginTop: '2rem', maxWidth: '65ch' }}>
            <h2 style={{ fontSize: '1.15rem' }}>Credentials</h2>
            <ul>
              {f.credentials.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        )}

        {/* Scope of practice, shown verbatim and deliberately not buried in a
            footer. Coaches, breathwork facilitators and licensed psychologists
            are not interchangeable, and a client choosing between them is
            entitled to know which one they are booking. */}
        {f.scope_note && (
          <div className="alert alert-info" style={{ marginTop: '2rem', maxWidth: '65ch' }}>
            <strong>Scope of practice</strong>
            <p style={{ margin: '0.4rem 0 0' }}>{f.scope_note}</p>
          </div>
        )}

        <h2 style={{ marginTop: '3rem' }}>Book a session</h2>

        {freeCall && (
          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <span className="pill pill-ok">Complimentary</span>
            <h3 style={{ margin: '0.6rem 0 0.3rem' }}>{freeCall.title}</h3>
            <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
              {formatDuration(freeCall.duration_minutes)} · free
            </p>
            <p style={{ maxWidth: '55ch' }}>
              A short conversation to understand what you're looking for and see whether{' '}
              {f.display_name.split(' ')[0]} is the right fit for you. One per person.
            </p>
            <Link className="btn btn-accent" to={`/book/${f.slug}/${freeCall.id}`}>
              Book your intro call
            </Link>
          </div>
        )}

        {paid.length === 0 && !freeCall && (
          <p className="muted">This facilitator hasn't opened any sessions for booking yet.</p>
        )}

        <div className="grid">
          {paid.map((s) => (
            <div key={s.id} className="card">
              <h3 style={{ marginTop: 0, marginBottom: '0.3rem' }}>{s.title}</h3>
              <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
                {formatDuration(s.duration_minutes)}
                {s.kind === 'package' && s.sessions_count > 1 ? ` · ${s.sessions_count} sessions` : ''}
              </p>
              {s.description && (
                <div className="small" dangerouslySetInnerHTML={{ __html: s.description }} />
              )}
              <p className="price" style={{ marginTop: '0.9rem' }}>
                {money(s.price_centavos, s.currency)}
              </p>
              <Link className="btn btn-primary btn-block" to={`/book/${f.slug}/${s.id}`}>
                Choose a time
              </Link>
              {s.cancellation_policy && (
                <p className="small muted" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
                  {s.cancellation_policy}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

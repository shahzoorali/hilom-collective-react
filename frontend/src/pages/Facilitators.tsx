/**
 * `/facilitators` — the directory.
 *
 * Framed as "find the right person for where you are" rather than "book a
 * coach": the specialty filter is the first thing on the page because what
 * brings someone here is a situation, not a name they already know.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../components/Layout';
import { listFacilitators, type FacilitatorCard } from '../lib/booking';

export default function Facilitators() {
  const [facilitators, setFacilitators] = useState<FacilitatorCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [specialty, setSpecialty] = useState<string>('');

  useEffect(() => {
    let live = true;
    // Filtering happens client-side below, so this fetch is unfiltered and runs
    // once. The endpoint takes a `specialty` param for deep links and for a
    // future roster too large to ship whole.
    listFacilitators()
      .then((rows) => live && setFacilitators(rows))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  // Built from what facilitators actually list, not a hardcoded taxonomy — a
  // fixed list would go stale the first time someone offers something new.
  const specialties = useMemo(() => {
    const seen = new Set<string>();
    for (const f of facilitators ?? []) for (const s of f.specialties) seen.add(s);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [facilitators]);

  const visible = useMemo(
    () => (facilitators ?? []).filter((f) => !specialty || f.specialties.includes(specialty)),
    [facilitators, specialty],
  );

  return (
    <section className="section">
      <div className="container">
        <h1>Find the right person for where you are</h1>
        <p className="desc" style={{ maxWidth: '48ch' }}>
          Our facilitators work in different ways and with different things. Start with a
          complimentary call to see who fits — no commitment either way.
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        {specialties.length > 0 && (
          <div className="tag-chips" style={{ margin: '1.5rem 0 2rem' }}>
            <button
              type="button"
              className={`tag-chip${specialty === '' ? ' tag-chip-active' : ''}`}
              onClick={() => setSpecialty('')}
            >
              Everyone
            </button>
            {specialties.map((s) => (
              <button
                key={s}
                type="button"
                className={`tag-chip${specialty === s ? ' tag-chip-active' : ''}`}
                onClick={() => setSpecialty(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {facilitators === null && !error && <div className="spinner" aria-label="Loading" />}

        {facilitators !== null && visible.length === 0 && (
          <p className="muted">
            {specialty
              ? `No facilitators are listed under "${specialty}" yet.`
              : 'No facilitators are listed yet — check back soon.'}
          </p>
        )}

        <div className="grid">
          {visible.map((f) => (
            <FacilitatorCardView key={f.id} facilitator={f} />
          ))}
        </div>

        <div className="panel" style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', marginTop: 0 }}>Are you a practitioner?</h2>
          <p className="small muted" style={{ marginBottom: '0.9rem' }}>
            Offer your coaching, breathwork, or wellness practice through Hilom — you set your own
            hours and prices, and we handle booking and payment.
          </p>
          <Link className="btn btn-ghost" to="/facilitators/apply">
            Apply to facilitate
          </Link>
        </div>
      </div>
    </section>
  );
}

function FacilitatorCardView({ facilitator }: { facilitator: FacilitatorCard }) {
  const { slug, display_name, headline, photo_url, specialties, location, hasFreeCall, fromCentavos } =
    facilitator;

  return (
    <Link to={`/facilitators/${slug}`} className="card facilitator-card">
      {photo_url ? (
        <img src={photo_url} alt="" className="facilitator-card__photo" loading="lazy" />
      ) : (
        // A neutral monogram rather than a stock silhouette: an obviously
        // generic stand-in photo reads as a fake profile.
        <div className="facilitator-card__photo facilitator-card__monogram" aria-hidden="true">
          {display_name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="facilitator-card__body">
        <h3 style={{ margin: '0 0 0.25rem' }}>{display_name}</h3>
        {headline && <p className="small muted" style={{ margin: '0 0 0.6rem' }}>{headline}</p>}

        {specialties.length > 0 && (
          <p className="small" style={{ margin: '0 0 0.6rem' }}>
            {specialties.slice(0, 3).join(' · ')}
          </p>
        )}

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="small muted">{location ?? 'Online'}</span>
          <span className="small">
            {hasFreeCall ? (
              <span className="pill pill-ok">Free intro call</span>
            ) : fromCentavos !== null ? (
              <>from {money(fromCentavos)}</>
            ) : null}
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * `/facilitators` — the directory.
 *
 * Framed as "find the right person for where you are" rather than "book a
 * coach": what brings someone here is a situation, not a name they already
 * know. The roster is shown whole — no filter — because it is small and a
 * chip row built from free-text "what I help with" lines produces a wall of
 * near-duplicate one-offs rather than a taxonomy.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Stars } from '../components/Stars';
import { money } from '../components/Layout';
import { listFacilitators, type FacilitatorCard } from '../lib/booking';
import { SkeletonCardGrid } from '../components/Skeleton';
import { captureFlip } from '../lib/pageFlip';

export default function Facilitators() {
  const [facilitators, setFacilitators] = useState<FacilitatorCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listFacilitators()
      .then((rows) => live && setFacilitators(rows))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="section">
      <div className="container">
        <h1>Find the right person for where you are</h1>
        <p className="desc" style={{ maxWidth: '48ch' }}>
          Our facilitators work in different ways and with different things. Start with a
          complimentary call to see who fits — no commitment either way.
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        {facilitators === null && !error && <SkeletonCardGrid count={6} />}

        {facilitators !== null && facilitators.length === 0 && (
          <p className="muted">No facilitators are listed yet — check back soon.</p>
        )}

        <div className="grid" style={{ marginTop: '2rem' }}>
          {(facilitators ?? []).map((f) => (
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
  const { slug, display_name, headline, photo_url, specialties, location, hasFreeCall, fromCentavos, rating } =
    facilitator;
  const cardRef = useRef<HTMLAnchorElement>(null);

  return (
    <Link
      to={`/facilitators/${slug}`}
      className="card facilitator-card"
      ref={cardRef}
      onClick={() => captureFlip(cardRef.current)}
    >
      {photo_url ? (
        <img src={photo_url} alt="" className="facilitator-card__photo" data-flip-id={`facilitator-photo-${slug}`} loading="lazy" />
      ) : (
        // A neutral monogram rather than a stock silhouette: an obviously
        // generic stand-in photo reads as a fake profile.
        <div
          className="facilitator-card__photo facilitator-card__monogram"
          data-flip-id={`facilitator-photo-${slug}`}
          aria-hidden="true"
        >
          {display_name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="facilitator-card__body">
        <h3 style={{ margin: '0 0 0.25rem' }} data-flip-id={`facilitator-title-${slug}`}>{display_name}</h3>
        {headline && <p className="small muted" style={{ margin: '0 0 0.6rem' }}>{headline}</p>}

        {/* Nothing at all when there are no reviews yet. "No rating" and a
            zero-star row read very differently, and only one of them is true —
            see RatingSummary. */}
        {rating?.average !== null && rating?.average !== undefined && (
          <p className="small" style={{ margin: '0 0 0.6rem' }}>
            <Stars value={rating.average} />{' '}
            <span className="muted">
              {rating.average.toFixed(1)} ({rating.count})
            </span>
          </p>
        )}

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

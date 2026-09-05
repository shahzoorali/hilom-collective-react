/**
 * `/facilitators` — the directory.
 *
 * Framed as "find the right person for where you are" rather than "book a
 * coach": what brings someone here is a situation, not a name they already
 * know.
 *
 * Laid out as the marketing system's directory (see the `cv-` layer in
 * index.css): a filter rail beside a grid of person cards, each carrying its
 * specialties as chips.
 *
 * The rail is built from the roster itself and deliberately **only lists a
 * specialty two or more facilitators share**. Specialties are free text, so
 * every one-off — "somatic parts work for new fathers" — would otherwise
 * become its own checkbox and turn the rail into a wall of near-duplicates
 * that filter to a single card each. Below two shared facets there is nothing
 * worth filtering on and the rail is not rendered at all.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Stars } from '../components/Stars';
import { money } from '../components/Layout';
import { listFacilitators, type FacilitatorCard } from '../lib/booking';
import { SkeletonCardGrid } from '../components/Skeleton';
import { captureFlip } from '../lib/pageFlip';

/** Specialties shared by at least two facilitators, alphabetised. */
function sharedSpecialties(rows: FacilitatorCard[]): string[] {
  const counts = new Map<string, number>();
  for (const f of rows) {
    // A facilitator listing the same thing twice must not count as two people.
    for (const s of new Set(f.specialties)) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([s]) => s)
    .sort((a, b) => a.localeCompare(b));
}

export default function Facilitators() {
  const [facilitators, setFacilitators] = useState<FacilitatorCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [freeCallOnly, setFreeCallOnly] = useState(false);

  useEffect(() => {
    let live = true;
    listFacilitators()
      .then((rows) => live && setFacilitators(rows))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  const facets = useMemo(() => sharedSpecialties(facilitators ?? []), [facilitators]);

  // OR within the specialty list, AND against the free-call switch: ticking two
  // specialties should widen the result, not narrow it to people who do both.
  const shown = (facilitators ?? []).filter((f) => {
    if (freeCallOnly && !f.hasFreeCall) return false;
    if (selected.size === 0) return true;
    return f.specialties.some((s) => selected.has(s));
  });

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const filtering = selected.size > 0 || freeCallOnly;
  const showRail = facets.length >= 2;

  return (
    <>
      <section className="cv-band cv-band--white">
        <div className="container">
          <div className="cv-head cv-head--center" style={{ marginBottom: '2.5rem' }}>
            <h1>Find the right person for where you are</h1>
            <p>
              Our facilitators work in different ways and with different things. Start with a
              complimentary call to see who fits — no commitment either way.
            </p>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          {facilitators === null && !error && <SkeletonCardGrid count={6} />}
          {facilitators !== null && facilitators.length === 0 && (
            <p className="muted cv-center">No facilitators are listed yet — check back soon.</p>
          )}

          {facilitators !== null && facilitators.length > 0 && (
            <div className={showRail ? 'cv-directory' : undefined}>
              {showRail && (
                <div className="cv-filters">
                  <h3>Search by:</h3>
                  <label>
                    <input
                      type="checkbox"
                      checked={freeCallOnly}
                      onChange={(e) => setFreeCallOnly(e.target.checked)}
                    />
                    Offers a free intro call
                  </label>

                  <h3>Works with:</h3>
                  {facets.map((name) => (
                    <label key={name}>
                      <input
                        type="checkbox"
                        checked={selected.has(name)}
                        onChange={() => toggle(name)}
                      />
                      {name}
                    </label>
                  ))}

                  {filtering && (
                    <button
                      type="button"
                      className="cv-filters__reset"
                      onClick={() => {
                        setSelected(new Set());
                        setFreeCallOnly(false);
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              <div>
                {shown.length === 0 ? (
                  <p className="muted">
                    Nobody matches that combination yet. Try clearing a filter.
                  </p>
                ) : (
                  <div className="cv-people">
                    {shown.map((f) => (
                      <FacilitatorCardView key={f.id} facilitator={f} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="cv-band cv-band--forest">
        <div className="container cv-center">
          <div className="cv-head cv-head--center">
            <p className="cv-eyebrow">Are you a practitioner?</p>
            <h2>Facilitate with Hilom</h2>
            <p>
              Offer your coaching, breathwork, or wellness practice through Hilom — you set your
              own hours and prices, and we handle booking and payment.
            </p>
          </div>
          <p style={{ marginTop: '2rem' }}>
            <Link className="btn btn-primary" to="/facilitators/apply">
              Apply to facilitate
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}

function FacilitatorCardView({ facilitator }: { facilitator: FacilitatorCard }) {
  const { slug, display_name, headline, photo_url, specialties, location, hasFreeCall, fromCentavos, rating } =
    facilitator;
  const cardRef = useRef<HTMLElement>(null);

  return (
    <article className="cv-person" ref={cardRef}>
      <div className="cv-person__photo">
        {photo_url ? (
          <img src={photo_url} alt="" data-flip-id={`facilitator-photo-${slug}`} loading="lazy" />
        ) : (
          // A neutral monogram rather than a stock silhouette: an obviously
          // generic stand-in photo reads as a fake profile.
          <div
            className="cv-person__monogram"
            data-flip-id={`facilitator-photo-${slug}`}
            aria-hidden="true"
          >
            {display_name.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>

      <div className="cv-person__body">
        <h3 className="cv-person__name" data-flip-id={`facilitator-title-${slug}`}>
          {display_name}
        </h3>
        {headline && <p className="cv-person__role">{headline}</p>}

        {/* Nothing at all when there are no reviews yet. "No rating" and a
            zero-star row read very differently, and only one of them is true —
            see RatingSummary. */}
        {rating?.average !== null && rating?.average !== undefined && (
          <p className="small" style={{ margin: '0 0 0.7rem' }}>
            <Stars value={rating.average} />{' '}
            <span className="muted">
              {rating.average.toFixed(1)} ({rating.count})
            </span>
          </p>
        )}

        {specialties.length > 0 && (
          <ul className="cv-chips">
            {specialties.slice(0, 3).map((s) => (
              <li className="cv-chip" key={s}>
                {s}
              </li>
            ))}
          </ul>
        )}

        <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
          {location ?? 'Online'}
          {hasFreeCall ? ' · Free intro call' : fromCentavos !== null ? ` · from ${money(fromCentavos)}` : ''}
        </p>

        <Link
          className="cv-person__link"
          to={`/facilitators/${slug}`}
          onClick={() => captureFlip(cardRef.current)}
        >
          View profile &rarr;
        </Link>
      </div>
    </article>
  );
}

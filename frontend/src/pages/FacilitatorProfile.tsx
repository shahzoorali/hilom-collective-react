/**
 * `/facilitators/:slug` — one facilitator, and what they offer.
 *
 * Laid out like a professional practitioner listing: a header band that
 * establishes who this is at a glance, a main column for their approach and
 * the sessions they run, and a sidebar carrying the things a client weighs
 * before booking — experience, credentials, and the scope-of-practice
 * statement.
 *
 * The free exploratory call is pulled out of the service list and given its
 * own card. It is the lowest-friction way into the whole marketplace, and
 * burying it as the cheapest row in a price list would waste that.
 *
 * The markup itself lives in `components/FacilitatorProfileView.tsx`, shared
 * with the admin profile editor's live preview. This file is the page around
 * it: fetching, the loading and error states, and the document head.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getFacilitator } from '../lib/booking';
import { Skeleton, SkeletonText, SkeletonBoundary } from '../components/Skeleton';
import FacilitatorProfileView from '../components/FacilitatorProfileView';
import { playFlip } from '../lib/pageFlip';
import { useDocumentHead } from '../lib/useDocumentHead';

export default function FacilitatorProfile() {
  const { slug = '' } = useParams();
  // Derived from the fetcher rather than restated, so adding a field to the
  // endpoint cannot leave this annotation describing an older response — which
  // is exactly what happened when `rating` and `reviews` were added.
  const [data, setData] = useState<Awaited<ReturnType<typeof getFacilitator>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);

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

  // Mirrors ProductDetail.tsx: fires once the real content — and its
  // matching data-flip-id elements — replace the skeleton.
  useLayoutEffect(() => {
    if (data) playFlip(root.current);
  }, [data]);

  const facilitator = data?.facilitator;
  useDocumentHead({
    title: facilitator ? `${facilitator.display_name} — Hilom Collective` : 'Facilitators — Hilom Collective',
    description:
      facilitator?.headline ||
      facilitator?.bio ||
      (facilitator ? `Book a session with ${facilitator.display_name} on Hilom Collective.` : null),
    path: `/facilitators/${slug}`,
    imageUrl: facilitator?.photo_url,
  });

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
        <SkeletonBoundary label="Loading facilitator" className="container" style={{ display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <Skeleton width={140} height={140} radius={12} />
            <div style={{ flex: 1, display: 'grid', gap: '0.6rem' }}>
              <Skeleton height="2em" width="45%" />
              <Skeleton height="1em" width="70%" />
              <Skeleton height="1em" width="55%" />
            </div>
          </div>
          <SkeletonText lines={4} />
          <div className="grid">
            {Array.from({ length: 2 }, (_, i) => (
              <div className="card" key={i} style={{ gap: '0.6rem' }}>
                <Skeleton height="1.3em" width="60%" />
                <SkeletonText lines={2} />
                <Skeleton height="2.6em" width="100%" radius={10} />
              </div>
            ))}
          </div>
        </SkeletonBoundary>
      </section>
    );
  }

  return (
    <FacilitatorProfileView
      facilitator={data.facilitator}
      services={data.services}
      rating={data.rating}
      reviews={data.reviews}
      rootRef={root}
      backLink={
        <div className="container">
          <Link to="/facilitators" className="linklike small">← All facilitators</Link>
        </div>
      }
    />
  );
}

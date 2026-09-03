/**
 * Admin → Reviews.
 *
 * The moderation queue behind the `pending/approved/rejected` statuses that
 * have sat unused in `facilitator_reviews` since 0013.
 *
 * What this screen is *not* for is worth being explicit about, because the
 * temptation is real and acting on it would quietly destroy the feature: this
 * is not a quality bar on the opinion. A one-star review of a session that went
 * badly is exactly what the ratings are for, and rejecting it because it is
 * unflattering makes every remaining review worthless. What is being checked is
 * whether something about to be published permanently, under a real
 * practitioner's name, is abuse, somebody's phone number, or a clinical
 * disclosure the client will regret making public.
 *
 * Nothing is ever deleted. A rejected review can be approved later and the
 * rating follows either way — the trigger in 0036 keys on the status rather
 * than on the transition.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Stars } from '../../components/Stars';
import {
  adminListReviews,
  adminSetReviewStatus,
  type AdminReview,
  type ReviewStatus,
} from '../../lib/booking';

const FILTERS: { label: string; value: ReviewStatus }[] = [
  { label: 'Waiting', value: 'pending' },
  { label: 'Published', value: 'approved' },
  { label: 'Not published', value: 'rejected' },
];

export default function ReviewsTab({ adminKey }: { adminKey: string }) {
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [reviews, setReviews] = useState<AdminReview[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setReviews(null);
    adminListReviews(adminKey, status)
      .then(setReviews)
      .catch((err: Error) => setError(err.message));
  }, [adminKey, status]);

  useEffect(() => reload(), [reload]);

  async function decide(review: AdminReview, next: 'approved' | 'rejected') {
    setBusyId(review.id);
    setError(null);
    try {
      await adminSetReviewStatus(adminKey, review.id, next);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that review');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Reviews</h2>
        <div className="row" style={{ gap: '0.4rem' }}>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={status === f.value ? 'btn btn-accent small' : 'btn btn-ghost small'}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <p className="small muted" style={{ maxWidth: '70ch' }}>
        Reviews come from clients who booked and attended. Publish honest ones, including
        unflattering ones — a rating with the bad reviews filtered out tells nobody anything. Hold
        back abuse, contact details, and anything about someone's health they may not have meant
        to make public.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {reviews === null && <div className="spinner" aria-label="Loading" />}
      {reviews !== null && reviews.length === 0 && (
        <p className="muted">
          {status === 'pending' ? 'Nothing waiting to be read.' : 'Nothing here.'}
        </p>
      )}

      {(reviews ?? []).map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <Stars value={r.rating} />{' '}
              <strong style={{ marginLeft: '0.35rem' }}>
                {r.facilitators ? (
                  <Link to={`/facilitators/${r.facilitators.slug}`}>{r.facilitators.display_name}</Link>
                ) : (
                  'Unknown facilitator'
                )}
              </strong>
            </div>
            <span className="pill">{r.status}</span>
          </div>

          <p className="small muted" style={{ margin: '0.3rem 0 0' }}>
            {r.bookings?.facilitator_services?.title ?? 'Session'}
            {r.bookings?.starts_at && (
              <>
                {' '}
                ·{' '}
                {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(
                  new Date(r.bookings.starts_at),
                )}
              </>
            )}
            {' · '}
            {/* The full address is admin-only and is never published — the
                public review carries only `client_label`. It is here because
                judging a report sometimes means knowing who wrote it. */}
            {r.bookings?.client_email ?? 'unknown client'}
            {r.client_label && <> · shown as “{r.client_label}”</>}
          </p>

          {r.comment ? (
            <p style={{ margin: '0.5rem 0 0', whiteSpace: 'pre-wrap' }}>{r.comment}</p>
          ) : (
            <p className="small muted" style={{ margin: '0.5rem 0 0' }}>
              A rating with no comment.
            </p>
          )}

          <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
            {r.status !== 'approved' && (
              <button
                type="button"
                className="btn btn-accent small"
                disabled={busyId === r.id}
                onClick={() => void decide(r, 'approved')}
              >
                Publish
              </button>
            )}
            {r.status !== 'rejected' && (
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busyId === r.id}
                onClick={() => void decide(r, 'rejected')}
              >
                {r.status === 'approved' ? 'Unpublish' : "Don't publish"}
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

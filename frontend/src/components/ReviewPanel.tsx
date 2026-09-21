/**
 * "How was it?" — the client's review of a thing they attended.
 *
 * Extracted from the bookings screen when 0050 made reviews polymorphic. There
 * are now three places a review can be left — a 1:1 session, an event, a group
 * class — and they must be the same ask in each, because they all feed the
 * same facilitator average. Three copies of this panel would drift, and the
 * first thing to drift would be the moderation wording, which is the part that
 * stops a client assuming their review was thrown away.
 *
 * Parameterised by two functions rather than by a subject type. The component
 * has no opinion about what is being reviewed; the caller knows which endpoint
 * to hit, and that keeps the URL-shaped knowledge next to the screen that
 * already has the id.
 */
import { useEffect, useState } from 'react';
import type { MyReview } from '../lib/booking';
import { StarInput } from './Stars';

export default function ReviewPanel({
  load,
  save,
  hasReview,
  /** What was attended, for the copy: "session", "event", "class". */
  noun = 'session',
}: {
  load: () => Promise<{ review: MyReview | null; reviewable: boolean; reason?: string | null }>;
  save: (rating: number, comment: string) => Promise<MyReview>;
  hasReview?: boolean;
  noun?: string;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<MyReview | null>(null);
  const [reviewable, setReviewable] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded when opened rather than with the list. Most past sessions have no
  // review, and a request per row to find that out is a request per row for
  // nothing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    load()
      .then((r) => {
        if (!live) return;
        setReview(r.review);
        setReviewable(r.reviewable);
        setReason(r.reason ?? null);
        setRating(r.review?.rating ?? 0);
        setComment(r.review?.comment ?? '');
      })
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
    // `load` is a closure over an id that does not change while this is
    // mounted; depending on it would refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (rating < 1) return;
    setBusy(true);
    setError(null);
    try {
      setReview(await save(rating, comment));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your review');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {!open && (
        <button type="button" className="btn btn-ghost small" onClick={() => setOpen(true)}>
          {hasReview || review ? 'Your review' : 'How was it?'}
        </button>
      )}

      {open && (
        <div className="panel" style={{ marginTop: '0.5rem' }}>
          {error && <div className="alert alert-error">{error}</div>}
          {!loaded && !error && <div className="spinner" aria-label="Loading" />}

          {/* An event with no host facilitator has nobody to attribute a
              rating to (0050). Said in the server's own words, because the
              reason differs by case and inventing one here would eventually
              contradict it. */}
          {loaded && !reviewable && (
            <p className="small muted" style={{ marginTop: 0 }}>
              {reason ?? `You can leave a review once the ${noun} has happened.`}
            </p>
          )}

          {loaded && reviewable && (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                {review
                  ? 'You can change this at any time. Edits are read again before they appear.'
                  : 'A few words help the next person decide. We read reviews before they appear, and yours is shown with your first name and last initial.'}
              </p>

              <StarInput value={rating} onChange={setRating} disabled={busy} />

              <label className="field">
                <span>Anything you'd like to add? (optional)</span>
                <textarea
                  rows={4}
                  value={comment}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>

              {/* The status is worth saying plainly. A client who leaves a
                  review and never sees it appear assumes it was thrown away. */}
              {review && (
                <p className="small muted">
                  {review.status === 'pending' &&
                    'Waiting to be read — it will appear on the profile shortly.'}
                  {review.status === 'approved' && 'Published on their profile.'}
                  {review.status === 'rejected' &&
                    "This wasn't published. If you think that's wrong, email kumusta@hilomcollective.com."}
                </p>
              )}

              <div className="row" style={{ gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-accent small"
                  disabled={busy || rating < 1}
                  onClick={() => void submit()}
                >
                  {busy ? 'Saving…' : saved ? 'Saved' : review ? 'Update my review' : 'Leave my review'}
                </button>
                <button type="button" className="btn btn-ghost small" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {loaded && !reviewable && (
            <button type="button" className="btn btn-ghost small" onClick={() => setOpen(false)}>
              Close
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
 *
 * Built for working a queue: j/k move a cursor, a publishes, r holds back,
 * x selects for a bulk decision. A decided review leaves the list in place so
 * the cursor lands on the next one, and the toast offers Undo. The ⚑ flags are
 * pattern matches (contact details, health words, strong language) — prompts
 * to read carefully, never automatic rejections.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Stars } from '../../components/Stars';
import {
  adminListReviews,
  reviewSubject,
  adminSetReviewStatus,
  type AdminReview,
  type ReviewStatus,
} from '../../lib/booking';
import { adminToast } from './ui/feedback';
import { EmptyState } from './ui/EmptyState';

const FLAGS: { label: string; test: RegExp }[] = [
  { label: 'Phone number', test: /(\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}|\b\d{3}[\s-]\d{3,4}[\s-]\d{4}\b/ },
  { label: 'Email address', test: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { label: 'Link', test: /https?:\/\/|www\.|\.com\b/i },
  {
    label: 'Health disclosure',
    test: /\b(depress|anxiety|suicid|self[- ]harm|diagnos|medication|bipolar|ptsd|panic attack|pregnan)/i,
  },
  { label: 'Strong language', test: /\b(fuck|shit|bitch|asshole|bastard|putang|gago|tangina|ulol)/i },
];
const flagsFor = (text: string | null) => (text ? FLAGS.filter((f) => f.test.test(text)).map((f) => f.label) : []);

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
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const reload = useCallback(() => {
    setReviews(null);
    adminListReviews(adminKey, status)
      .then(setReviews)
      .catch((err: Error) => setError(err.message));
  }, [adminKey, status]);

  useEffect(() => reload(), [reload]);
  useEffect(() => {
    setCursor(0);
    setSelected(new Set());
  }, [status]);

  const visible = useMemo(
    () => (reviews ?? []).filter((r) => !flaggedOnly || flagsFor(r.comment).length > 0),
    [reviews, flaggedOnly],
  );
  const flaggedCount = useMemo(() => (reviews ?? []).filter((r) => flagsFor(r.comment).length).length, [reviews]);

  async function decide(review: AdminReview, next: 'approved' | 'rejected', quiet = false) {
    setBusyId(review.id);
    setError(null);
    const prev = review.status;
    try {
      await adminSetReviewStatus(adminKey, review.id, next);
      setReviews((rs) => (rs ?? []).filter((r) => r.id !== review.id));
      if (!quiet) {
        adminToast.success(next === 'approved' ? 'Published' : 'Held back', {
          label: 'Undo',
          run: async () => {
            // There is no transition back to pending; a pending review's undo
            // is the opposite decision, which leaves it findable and reversible.
            const back = prev === 'pending' ? (next === 'approved' ? 'rejected' : 'approved') : prev;
            await adminSetReviewStatus(adminKey, review.id, back);
            reload();
          },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that review');
    } finally {
      setBusyId(null);
    }
  }

  async function decideMany(next: 'approved' | 'rejected') {
    const list = visible.filter((r) => selected.has(r.id));
    for (const r of list) await decide(r, next, true);
    setSelected(new Set());
    adminToast.success(`${list.length} review${list.length === 1 ? '' : 's'} ${next === 'approved' ? 'published' : 'held back'}`);
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.admin-modal-overlay')) return;
      const cur = visible[cursor];
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, visible.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'a' && cur && cur.status !== 'approved' && !busyId) {
        void decide(cur, 'approved');
      } else if (e.key === 'r' && cur && cur.status !== 'rejected' && !busyId) {
        void decide(cur, 'rejected');
      } else if (e.key === 'x' && cur) {
        toggle(cur.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, cursor, busyId]);

  useEffect(() => {
    if (cursor >= visible.length && visible.length) setCursor(visible.length - 1);
    document.getElementById(`review-${visible[cursor]?.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, visible]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Reviews</h2>
          <p className="small muted">
            {status === 'pending' && reviews ? `${reviews.length} waiting` : 'Moderation queue'}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Status">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>
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

      <div className="row" style={{ margin: '0.5rem 0 0.75rem' }}>
        <label className="row" style={{ gap: '0.35rem', margin: 0, fontWeight: 500 }}>
          <input
            type="checkbox"
            style={{ width: 'auto', margin: 0 }}
            checked={flaggedOnly}
            onChange={(e) => setFlaggedOnly(e.target.checked)}
          />
          Only flagged ({flaggedCount})
        </label>
        <span className="kbd-hint" style={{ marginLeft: 'auto' }}>
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> publish · <kbd>r</kbd> hold back · <kbd>x</kbd> select
        </span>
      </div>

      {selected.size > 0 && (
        <div className="dt__bulk" style={{ marginBottom: '0.75rem' }}>
          <strong>{selected.size} selected</strong>
          {status !== 'approved' && (
            <button type="button" className="btn btn-accent small" onClick={() => void decideMany('approved')}>
              Publish all
            </button>
          )}
          {status !== 'rejected' && (
            <button type="button" className="btn btn-ghost small" onClick={() => void decideMany('rejected')}>
              Hold back all
            </button>
          )}
          <button type="button" className="btn-link small" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}
      {reviews === null &&
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card" style={{ marginBottom: '0.75rem' }} aria-hidden="true">
            <span className="skeleton" style={{ width: '40%', height: '1em' }} />
            <span className="skeleton" style={{ width: '90%', height: '0.9em', marginTop: '0.6rem' }} />
            <span className="skeleton" style={{ width: '70%', height: '0.9em', marginTop: '0.4rem' }} />
          </div>
        ))}
      {reviews !== null && visible.length === 0 && (
        <EmptyState
          icon="star"
          title={status === 'pending' ? 'Inbox zero' : 'Nothing here'}
          body={status === 'pending' ? 'Nothing waiting to be read. New reviews arrive after a client attends.' : undefined}
        />
      )}

      {visible.map((r, i) => {
        const flags = flagsFor(r.comment);
        const subject = reviewSubject(r);
        return (
          <div
            key={r.id}
            id={`review-${r.id}`}
            className="card"
            onClick={() => setCursor(i)}
            style={{
              marginBottom: '0.75rem',
              outline: i === cursor ? '2px solid var(--forest)' : undefined,
              outlineOffset: 2,
              background: selected.has(r.id) ? 'var(--admin-sel)' : undefined,
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <input
                  type="checkbox"
                  aria-label="Select review"
                  style={{ width: 'auto', margin: '0 0.5rem 0 0' }}
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                />
                <Stars value={r.rating} />{' '}
                <strong style={{ marginLeft: '0.35rem' }}>
                  {r.facilitators ? (
                    <Link to={`/facilitators/${r.facilitators.slug}`}>{r.facilitators.display_name}</Link>
                  ) : (
                    'Unknown facilitator'
                  )}
                </strong>
              </div>
              <span className="row" style={{ gap: '0.3rem' }}>
                {flags.map((f) => (
                  <span key={f} className="pill pill-warn" title="Pattern match — read before publishing">
                    ⚑ {f}
                  </span>
                ))}
                <span className="pill">{r.status}</span>
              </span>
            </div>

            <p className="small muted" style={{ margin: '0.3rem 0 0' }}>
              {/* A review can be of a 1:1, an event or a group class (0050), and
                  the kind is named out loud: "the room was freezing" is fair
                  comment on a venue and nonsense about a Zoom call. */}
              <span className="pill" style={{ fontSize: '0.7rem', marginRight: '0.35rem' }}>
                {subject.kind}
              </span>
              {subject.title}
              {subject.when && (
                <> · {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(subject.when))}</>
              )}
              {' · '}
              {/* The full address is admin-only and is never published — the
                  public review carries only `client_label`. */}
              {r.bookings?.client_email ??
                r.event_registrations?.registrant_name ??
                r.class_registrations?.client_name ??
                'unknown client'}
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
        );
      })}
    </>
  );
}

/**
 * Account → the group classes this person has joined (0049).
 *
 * The joining link only ever appears here for a confirmed seat — the backend
 * strips it from a pending row — so there is no status check to repeat on this
 * side, the same arrangement the event registration screen relies on.
 *
 * Upcoming and past are one list rather than two tabs. Someone opening this
 * screen on a Thursday morning wants the next thing, and the past is a short
 * tail underneath it, not a section worth navigating to.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import ReviewPanel from '../../components/ReviewPanel';
import {
  listMyJoinedClasses,
  getMyClassReview,
  saveMyClassReview,
  viewerTimezone,
  formatInZone,
} from '../../lib/booking';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Still paying',
  confirmed: 'Confirmed',
  completed: 'Attended',
  cancelled: 'Cancelled',
  expired: 'Lapsed',
};

export default function ClassesPanel() {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = viewerTimezone();

  useEffect(() => {
    listMyJoinedClasses()
      .then(setRows)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (rows === null) return <div className="spinner" aria-label="Loading" />;
  // Renders nothing at all when there are none: an empty "Group classes"
  // heading on the account of someone who has never joined one is clutter
  // telling them about a feature in the least useful possible place.
  if (rows.length === 0) return null;

  return (
    <section style={{ marginTop: '2rem' }}>
      <h2>Group classes</h2>

      {rows.map((r) => {
        const session = r.facilitator_class_sessions;
        const cls = session?.facilitator_classes;
        const facilitator = session?.facilitators;
        const past = Date.parse(String(session?.ends_at ?? session?.starts_at)) < Date.now();
        const cancelled = session?.status === 'cancelled';

        return (
          <div key={r.id} className="card" style={{ marginBottom: '0.6rem', opacity: past ? 0.8 : 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <strong>{cls?.title}</strong>
                <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
                  {session?.starts_at &&
                    formatInZone(session.starts_at, zone, {
                      dateStyle: 'full',
                      timeStyle: 'short',
                    })}
                  {facilitator && (
                    <>
                      {' · with '}
                      <Link to={`/facilitators/${facilitator.slug}`}>{facilitator.display_name}</Link>
                    </>
                  )}
                </p>
              </div>
              <span className="pill">{STATUS_LABEL[r.status] ?? r.status}</span>
            </div>

            {/* The session being cancelled is a different fact from the seat
                being cancelled, and it is the one the person needs first. */}
            {cancelled && (
              <div className="alert alert-warning" style={{ margin: '0.6rem 0 0' }}>
                <strong>This class was cancelled.</strong>{' '}
                {/* "We'll be in touch" is what someone writes when they do not
                    want to commit to anything, and it reads that way. What is
                    actually true is more reassuring and more useful: the money
                    is coming back in full, a person is doing it rather than a
                    system, and here is roughly when to worry. */}
                {r.price_centavos > 0 ? (
                  <>
                    You are due a full refund of {money(r.price_centavos, r.currency)}. Hilom
                    issues these by hand, so allow a few working days — if it has not
                    arrived within a week, email{' '}
                    <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a>.
                  </>
                ) : (
                  <>Nothing was charged for this one.</>
                )}
              </div>
            )}

            {r.price_centavos > 0 && (
              <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                {money(r.price_centavos, r.currency)}
              </p>
            )}

            {session?.meeting_url && !past && !cancelled && (
              <p style={{ margin: '0.6rem 0 0' }}>
                <a className="btn btn-secondary small" href={session.meeting_url} target="_blank" rel="noopener noreferrer">
                  Join the class
                </a>
              </p>
            )}

            {past && !cancelled && r.status !== 'expired' && (
              <ReviewPanel
                noun="class"
                load={() => getMyClassReview(r.id)}
                save={(rating, comment) => saveMyClassReview(r.id, rating, comment)}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

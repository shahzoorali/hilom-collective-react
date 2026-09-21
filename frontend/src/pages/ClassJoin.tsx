/**
 * `/classes/:sessionId` — join one group class (0049).
 *
 * Deliberately a single page rather than the multi-step flow a 1:1 booking
 * uses. A booking has to pick a slot, answer an intake and agree a policy; a
 * class has one time, already chosen, and the only decision left is whether to
 * come. Anything more than "here is the class, here is Join" is friction added
 * for symmetry's sake.
 *
 * The minimum is shown and explicitly declawed in the copy. Someone reading
 * "runs with 3+" on a class with 2 people needs to know their place is safe,
 * or they will assume it is about to be cancelled and not book.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getClassSession, joinClassSession, viewerTimezone, formatInZone } from '../lib/booking';
import { displayPrice } from '../components/Layout';
import { currentUser, login } from '../lib/auth';
import { useDocumentHead } from '../lib/useDocumentHead';

export default function ClassJoin() {
  const { sessionId = '' } = useParams();
  const [session, setSession] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  const zone = viewerTimezone();

  useEffect(() => {
    let live = true;
    getClassSession(sessionId)
      .then((s) => live && setSession(s as Record<string, any>))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [sessionId]);

  const cls = session?.facilitator_classes;
  const facilitator = session?.facilitators;

  useDocumentHead({
    title: cls ? `${cls.title} — Hilom Collective` : 'Group class — Hilom Collective',
    description: cls?.description ?? null,
    path: `/classes/${sessionId}`,
  });

  async function join() {
    if (!currentUser()) {
      // Comes back here afterwards, so signing in does not cost them the page.
      void login(window.location.pathname);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await joinClassSession(sessionId, { notes });
      if (result.free) {
        setJoined(true);
      } else if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that class');
      // Re-read, because the most likely reason to land here is that the class
      // filled up while this page was open, and the seat count on screen is
      // now wrong.
      getClassSession(sessionId)
        .then((s) => setSession(s as Record<string, any>))
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (error && !session) {
    return (
      <section className="section">
        <div className="container">
          <div className="alert alert-error">{error}</div>
          <Link to="/facilitators" className="linklike">← All facilitators</Link>
        </div>
      </section>
    );
  }

  if (!session) {
    return (
      <section className="section">
        <div className="container">
          <div className="spinner" aria-label="Loading" />
        </div>
      </section>
    );
  }

  if (joined) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 620 }}>
          <h1>You're in</h1>
          <p className="lede">
            Your place at {cls.title} on{' '}
            {formatInZone(session.starts_at, zone, { dateStyle: 'full', timeStyle: 'short' })} is
            confirmed.
          </p>
          <p>
            The joining details are on <Link to="/account">your account</Link>, and we have emailed
            them to you.
          </p>
        </div>
      </section>
    );
  }

  const full = Boolean(session.full);
  const price = Number(session.price_centavos);

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 620 }}>
        <Link to={`/facilitators/${facilitator?.slug ?? ''}`} className="linklike small">
          ← {facilitator?.display_name}
        </Link>

        <h1 style={{ marginTop: '0.5rem' }}>{cls.title}</h1>
        <p className="lede" style={{ fontWeight: 600, color: 'var(--forest)' }}>
          {formatInZone(session.starts_at, zone, { dateStyle: 'full', timeStyle: 'short' })}
        </p>

        <p className="small muted">
          {cls.delivery_mode === 'online'
            ? 'Online'
            : cls.delivery_mode === 'in_person'
              ? `In person${cls.location ? ` · ${cls.location}` : ''}`
              : 'Online or in person'}
          {' · '}
          {cls.duration_minutes} minutes
          {' · '}
          with {facilitator?.display_name}
        </p>

        {cls.description && <p className="desc">{cls.description}</p>}

        <div className="panel" style={{ marginTop: '1.25rem' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {price === 0 ? 'Free' : displayPrice(price)}
          </p>
          <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
            {full
              ? 'This one is full.'
              : `${session.seatsLeft} of ${session.capacity} places left.`}
            {/* Stated plainly. The alternative is someone seeing "runs with
                3+" next to "2 joined" and assuming it is about to fall
                through. */}
            {Number(session.min_joiners) > 1 && !session.meetsMinimum && (
              <> This class runs with {session.min_joiners} or more, and goes ahead either way.</>
            )}
          </p>

          {/* What happens to their money if the class does not. Said before
              they pay rather than in a policy page, because it is the one
              thing about this transaction that does not work the way an
              online purchase usually does: the refund is a person at Hilom
              doing it, not an automatic reversal. Someone who finds that out
              only after a cancellation reasonably assumes they have been
              forgotten. Hidden for a free class, where there is nothing to
              refund and the sentence would be noise. */}
          {price > 0 && !full && (
            <p className="small muted" style={{ margin: '0.5rem 0 0' }}>
              If {facilitator?.display_name ?? 'the facilitator'} has to cancel this class,
              Hilom refunds you in full — by hand, so allow a few working days. Refunds are
              not automatic.
            </p>
          )}
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginTop: '1rem' }}>
            {error}
          </div>
        )}

        {!full && (
          <>
            <label className="field" style={{ marginTop: '1rem' }}>
              <span>Anything {facilitator?.display_name} should know? (optional)</span>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>

            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void join()}
            >
              {busy ? 'One moment…' : price === 0 ? 'Join this class' : 'Join and pay'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

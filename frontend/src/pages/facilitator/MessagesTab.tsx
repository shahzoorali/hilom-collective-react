/**
 * Facilitator → Messages.
 *
 * The inbox. A facilitator's unit of attention is not the booking: someone with
 * a full week does not open twelve sessions to find out whether anyone has
 * asked them anything, they want the one list that says who is waiting on a
 * reply.
 *
 * Threads are per booking (0034), so this is a list of conversations *about
 * sessions* rather than about people — which is also why each row leads with
 * the session it concerns. A client who has had four sessions has four threads,
 * and their whole history is gathered on the Clients tab instead.
 */
import { useCallback, useEffect, useState } from 'react';
import MessageThread from '../../components/MessageThread';
import {
  formatInZone,
  listMyMessageThreads,
  viewerTimezone,
  type MessageThread as Thread,
} from '../../lib/booking';

/** Statuses where there is still something to arrange. */
const ACTIVE = new Set(['confirmed', 'completed', 'no_show']);

export default function MessagesTab() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = viewerTimezone();

  const reload = useCallback(() => {
    listMyMessageThreads()
      .then(setThreads)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => reload(), [reload]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (threads === null) return <div className="spinner" aria-label="Loading" />;

  return (
    <>
      <h2>Messages</h2>
      {threads.length === 0 && (
        <p className="muted">
          No conversations yet. Clients can message you about any booked session, and you can
          reply from here or from the booking itself.
        </p>
      )}

      {threads.map((t) => (
        <div key={t.bookingId} className="card" style={{ marginBottom: '0.6rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{t.clientName || t.clientEmail}</strong>
              {t.unread > 0 && (
                <span className="pill pill-warn" style={{ marginLeft: '0.4rem' }}>
                  {t.unread} new
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => {
                const next = openId === t.bookingId ? null : t.bookingId;
                setOpenId(next);
                // Opening marks the thread read server-side, so the badge here
                // is stale the moment it closes. Refetched rather than adjusted
                // locally, which would have to guess what the server did.
                if (next === null) reload();
              }}
            >
              {openId === t.bookingId ? 'Close' : 'Open'}
            </button>
          </div>

          <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
            {t.serviceTitle}
            {t.startsAt && (
              <> · {formatInZone(t.startsAt, zone, { dateStyle: 'medium', timeStyle: 'short' })}</>
            )}
          </p>

          {/* A one-line preview, so the list can be scanned without opening
              anything. Truncated with CSS rather than by slicing the string, so
              a long word does not lose its ending mid-character. */}
          <p
            className="small"
            style={{
              margin: '0.3rem 0 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <span className="muted">{t.lastSender === 'facilitator' ? 'You: ' : ''}</span>
            {t.lastMessage}
          </p>

          {openId === t.bookingId && (
            <MessageThread
              bookingId={t.bookingId}
              side="facilitator"
              otherName={(t.clientName || t.clientEmail || 'your client').split(' ')[0] ?? 'your client'}
              canWrite={ACTIVE.has(t.status ?? '')}
            />
          )}
        </div>
      ))}
    </>
  );
}

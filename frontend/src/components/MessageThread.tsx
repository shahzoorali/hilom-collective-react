/**
 * The conversation attached to one booking (0034).
 *
 * Used by both sides — the client's bookings page and the facilitator's
 * dashboard — with `side` deciding only which bubbles are "mine". Sharing it is
 * the point: a thread that looked different depending on who was reading would
 * make it harder for two people to talk about the same session.
 *
 * Loaded when opened, not with the page. Most bookings have no conversation at
 * all, and fetching a thread per row to discover that is a request per row for
 * nothing.
 */
import { useEffect, useRef, useState } from 'react';
import {
  formatInZone,
  listBookingMessages,
  sendBookingMessage,
  viewerTimezone,
  type BookingMessage,
} from '../lib/booking';

export default function MessageThread({
  bookingId,
  side,
  /** How the other person is named in the empty state. */
  otherName,
  /** False once the session is cancelled — there is nothing left to arrange. */
  canWrite = true,
}: {
  bookingId: string;
  side: 'client' | 'facilitator';
  otherName: string;
  canWrite?: boolean;
}) {
  const [messages, setMessages] = useState<BookingMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const zone = viewerTimezone();

  useEffect(() => {
    let live = true;
    listBookingMessages(bookingId, side === 'facilitator')
      .then((r) => live && setMessages(r))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [bookingId, side]);

  // A conversation is read from the bottom.
  useEffect(() => {
    if (messages && messages.length > 0) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const message = await sendBookingMessage(bookingId, body, side === 'facilitator');
      setMessages((current) => [...(current ?? []), message]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: '0.5rem' }}>
      {error && <div className="alert alert-error">{error}</div>}
      {messages === null && !error && <div className="spinner" aria-label="Loading" />}

      {messages !== null && messages.length === 0 && (
        <p className="small muted" style={{ marginTop: 0 }}>
          No messages yet. Anything you write here stays attached to this session, and{' '}
          {otherName} gets it by email — neither of you has to share a personal address.
        </p>
      )}

      {messages !== null && messages.length > 0 && (
        <div style={{ maxHeight: '22rem', overflowY: 'auto', marginBottom: '0.75rem' }}>
          {messages.map((m) => {
            const mine = m.sender === side;
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  justifyContent: mine ? 'flex-end' : 'flex-start',
                  marginBottom: '0.5rem',
                }}
              >
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 10,
                    background: mine ? 'var(--cream, #f5efe0)' : '#f2f2f0',
                  }}
                >
                  {/* pre-wrap, so a message typed with line breaks keeps them.
                      React escapes the text, so this is not an HTML surface. */}
                  <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {m.body}
                  </p>
                  <span className="small muted" style={{ fontSize: '0.75rem' }}>
                    {formatInZone(m.created_at, zone, { dateStyle: 'medium', timeStyle: 'short' })}
                    {mine && (m.read_at ? ' · read' : ' · sent')}
                  </span>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}

      {canWrite ? (
        <>
          <label className="field">
            <span className="sr-only">Your message</span>
            <textarea
              rows={2}
              value={draft}
              maxLength={5000}
              placeholder={`Message ${otherName}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // everywhere else people type short messages.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-accent small"
            disabled={busy || !draft.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      ) : (
        <p className="small muted" style={{ marginBottom: 0 }}>
          This session is no longer active, so the conversation is closed.
        </p>
      )}
    </div>
  );
}

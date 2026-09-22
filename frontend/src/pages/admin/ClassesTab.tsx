import { useCallback, useEffect, useState } from 'react';
import {
  adminListClasses,
  adminGetClassSessions,
  adminCancelClassSession,
  type AdminClass,
  type AdminClassSession,
} from '../../lib/booking';
import { money } from '../../components/Layout';

/**
 * Admin → Classes (docs/admin-dashboard-plan.md §5).
 *
 * The lever the panel never had: a facilitator could create a class, schedule
 * dates, see the roster and cancel one — an admin could do none of it. If a
 * facilitator stopped responding a week before a class, there was no way to
 * see who was booked or cancel it. The only class-shaped thing anywhere in
 * the panel was the refund queue inside Payouts.
 *
 * Cancel-a-date calls the exact same function the facilitator portal calls
 * (backend/src/lib/class-cancellation.ts), so a refund and an attendee email
 * are identical whoever pressed the button — see that file's header comment.
 */

const manilaDate = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

export default function ClassesTab({ adminKey }: { adminKey: string }) {
  const [classes, setClasses] = useState<AdminClass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminListClasses(adminKey)
      .then(setClasses)
      .catch((e: Error) => setError(e.message));
  }, [adminKey]);

  useEffect(reload, [reload]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 4000);
  }

  return (
    <div className="panel">
      <h2 style={{ fontSize: '1.15rem', marginTop: 0, marginBottom: '0.25rem' }}>Classes</h2>
      <p className="small muted" style={{ marginTop: 0, marginBottom: '1.25rem' }}>
        Every group class any facilitator teaches. Open one to see its scheduled dates and who has
        joined, and to cancel a date if the facilitator can't run it.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: 14 }}>{notice}</div>}

      {classes === null && !error && <div className="spinner" aria-label="Loading" />}

      {classes !== null && classes.length === 0 && (
        <p className="small muted">No classes have been created yet.</p>
      )}

      {classes !== null && classes.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {classes.map((c) => {
            const open = openId === c.id;
            return (
              <div key={c.id} className="panel" style={{ padding: 0 }}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : c.id)}
                  aria-expanded={open}
                  style={{
                    width: '100%',
                    background: 'none',
                    border: 0,
                    padding: '0.9rem 1.1rem',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <strong style={{ display: 'block' }}>
                      {c.title}
                      {!c.is_active && (
                        <span className="pill" style={{ marginLeft: 8 }}>
                          Deactivated
                        </span>
                      )}
                    </strong>
                    <span className="small muted">
                      {c.facilitators?.display_name ?? 'Unknown facilitator'} ·{' '}
                      {money(c.price_centavos, c.currency)} · up to {c.max_joiners}
                    </span>
                  </span>

                  <span style={{ textAlign: 'right', minWidth: 160 }}>
                    {c.nextSessionAt ? (
                      <>
                        <span style={{ display: 'block' }}>Next: {manilaDate(c.nextSessionAt)}</span>
                        <span className="small muted">
                          {c.nextSessionSeatsTaken ?? 0} of {c.max_joiners} seats ·{' '}
                          {c.upcomingSessionCount} upcoming
                        </span>
                      </>
                    ) : (
                      <span className="small muted">No upcoming dates</span>
                    )}
                  </span>

                  <span aria-hidden style={{ color: 'var(--muted)' }}>
                    {open ? '▲' : '▼'}
                  </span>
                </button>

                {open && (
                  <div style={{ padding: '0 1.1rem 1.1rem', borderTop: '1px solid var(--line)' }}>
                    <ClassSessions
                      adminKey={adminKey}
                      classId={c.id}
                      onError={setError}
                      onCancelled={(message) => {
                        flash(message);
                        reload();
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClassSessions({
  adminKey,
  classId,
  onError,
  onCancelled,
}: {
  adminKey: string;
  classId: string;
  onError: (message: string | null) => void;
  onCancelled: (message: string) => void;
}) {
  const [sessions, setSessions] = useState<AdminClassSession[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    adminGetClassSessions(adminKey, classId)
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => onError(e.message));
  }, [adminKey, classId, onError]);

  useEffect(reload, [reload]);

  async function cancel(session: AdminClassSession) {
    const reason = window.prompt(
      `Cancel the ${manilaDate(session.starts_at)} date?\n\n` +
        `${session.seatsTaken} seat${session.seatsTaken === 1 ? '' : 's'} will be released, and ` +
        `anyone who paid will be emailed and added to the refund queue.\n\n` +
        `Reason (shown to attendees):`,
    );
    if (reason === null) return;

    setBusyId(session.id);
    onError(null);
    try {
      const r = await adminCancelClassSession(adminKey, session.id, reason.trim() || undefined);
      onCancelled(
        `Cancelled. ${r.registrationsCancelled} registration${r.registrationsCancelled === 1 ? '' : 's'} released` +
          (r.refundsOwed > 0 ? `, ${money(r.refundTotalCentavos)} now owed to ${r.refundsOwed} of them.` : '.'),
      );
      reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (sessions === null) return <div className="spinner" aria-label="Loading" />;
  if (sessions.length === 0) return <p className="small muted">No dates have been scheduled.</p>;

  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
      {sessions.map((s) => {
        const live = s.roster.filter((r) => r.status !== 'cancelled');
        return (
          <div key={s.id} className="panel" style={{ background: 'var(--panel-alt, transparent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span>
                <strong style={{ display: 'block' }}>{manilaDate(s.starts_at)}</strong>
                <span className="small muted">
                  {s.seatsTaken} of {s.capacity} seats
                  {!s.meetsMinimum && s.status === 'scheduled' && ' · below minimum'}
                </span>
              </span>

              <span>
                {s.status === 'cancelled' && <span className="pill pill-bad">Cancelled</span>}
                {s.status === 'completed' && <span className="pill pill-ok">Completed</span>}
                {s.status === 'scheduled' && <span className="pill pill-warn">Scheduled</span>}
              </span>

              {s.status === 'scheduled' && (
                <button
                  type="button"
                  className="btn btn-ghost small"
                  style={{ color: '#8c2f1d', borderColor: '#f5c6bd' }}
                  onClick={() => void cancel(s)}
                  disabled={busyId === s.id}
                >
                  {busyId === s.id ? 'Cancelling…' : 'Cancel this date'}
                </button>
              )}
            </div>

            {s.cancelled_at && (
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Cancelled {manilaDate(s.cancelled_at)}
                {s.cancellation_reason ? ` — ${s.cancellation_reason}` : ''}
              </p>
            )}

            {live.length > 0 && (
              <div style={{ marginTop: 10, display: 'grid', gap: 2 }}>
                {live.map((seat) => (
                  <div
                    key={seat.id}
                    className="small"
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}
                  >
                    <span>
                      {seat.client_name ?? seat.client_email}
                      {seat.status === 'pending_payment' && (
                        <span className="muted"> — checkout not finished</span>
                      )}
                    </span>
                    {seat.refund_centavos != null && seat.refund_centavos > 0 && (
                      <span className={seat.refunded_at ? 'muted' : ''} style={{ color: seat.refunded_at ? undefined : 'var(--danger-fg)' }}>
                        {money(seat.refund_centavos)} {seat.refunded_at ? 'refunded' : 'owed'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

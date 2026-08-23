/**
 * Admin → Bookings.
 *
 * The screen support actually needs: every session on the platform, who it is
 * with, what was charged, and what is owed. `GET /admin/bookings` existed for
 * a while with nothing rendering it, which meant "what did this client book,
 * and what happened to it?" could only be answered from the database.
 *
 * Two things distinguish it from the facilitator's own bookings list. It spans
 * every facilitator, and it exposes the refund ledger — because the question
 * that costs Hilom money if nobody answers it is "who are we still supposed to
 * pay back?", and that is invisible from either side's own view.
 *
 * "Refunds due" is the default filter for the same reason: an unworked refund
 * queue is the one state here with a person waiting at the end of it.
 */
import { useCallback, useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import {
  adminCancelBooking,
  adminListBookings,
  adminMarkRefundSent,
  type AdminBooking,
} from '../../lib/booking';

const FILTERS: { label: string; value: string }[] = [
  { label: 'Refunds due', value: 'refund:due' },
  { label: 'Confirmed', value: 'status:confirmed' },
  { label: 'Completed', value: 'status:completed' },
  { label: 'Missed', value: 'status:no_show' },
  { label: 'Cancelled by client', value: 'status:cancelled_by_client' },
  { label: 'Cancelled by facilitator', value: 'status:cancelled_by_facilitator' },
  { label: 'Everything', value: '' },
];

const STATUS_PILL: Record<string, string> = {
  confirmed: 'pill-ok',
  completed: 'pill',
  no_show: 'pill-warn',
  pending_payment: 'pill-warn',
  cancelled_by_client: 'pill-bad',
  cancelled_by_facilitator: 'pill-bad',
  refunded: 'pill',
};

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default function BookingsTab({ adminKey }: { adminKey: string }) {
  const [filter, setFilter] = useState('refund:due');
  const [bookings, setBookings] = useState<AdminBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    const [kind, value] = filter.split(':');
    adminListBookings(adminKey, kind === 'refund' ? { refund: 'due' } : value ? { status: value } : undefined)
      .then(setBookings)
      .catch((err: Error) => setError(err.message));
  }, [adminKey, filter]);

  useEffect(() => reload(), [reload]);

  async function onCancel(b: AdminBooking) {
    const reason = window.prompt(
      'Cancel this session on Hilom\'s behalf?\n\n' +
        'The client is refunded in full whatever the notice period, and both sides are emailed.\n\n' +
        'Reason (shown to both):',
      '',
    );
    if (reason === null) return;

    setBusyId(b.id);
    setError(null);
    try {
      const res = await adminCancelBooking(adminKey, b.id, reason || undefined);
      setNotice(`Cancelled. ${money(res.refundCentavos)} is now owed to ${b.client_email}.`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusyId(null);
    }
  }

  async function onMarkRefunded(b: AdminBooking) {
    const reference = window.prompt(
      `Record ${money(b.refund_centavos ?? 0)} as refunded to ${b.client_email}.\n\n` +
        'This does not move any money — send it in PayMongo first, then paste the reference here.',
      '',
    );
    if (reference === null) return;
    if (!reference.trim()) {
      setError('A reference is required — it is the proof the money moved.');
      return;
    }

    setBusyId(b.id);
    setError(null);
    try {
      await adminMarkRefundSent(adminKey, b.id, reference.trim());
      setNotice('Refund recorded.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the refund');
    } finally {
      setBusyId(null);
    }
  }

  const totalDue = (bookings ?? [])
    .filter((b) => (b.refund_centavos ?? 0) > 0 && !b.refunded_at)
    .reduce((sum, b) => sum + (b.refund_centavos ?? 0), 0);

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Bookings</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {totalDue > 0 && (
        <div className="alert alert-info">
          <strong>{money(totalDue)}</strong> in refunds is owed and not yet sent.
        </div>
      )}

      {bookings === null && <div className="spinner" aria-label="Loading" />}
      {bookings !== null && bookings.length === 0 && (
        <p className="muted">
          {filter === 'refund:due' ? 'No refunds outstanding.' : 'Nothing here.'}
        </p>
      )}

      {(bookings ?? []).map((b) => {
        const refundOwed = (b.refund_centavos ?? 0) > 0 && !b.refunded_at;
        const isFuture = new Date(b.starts_at).getTime() > Date.now();

        return (
          <div key={b.id} className="card" style={{ marginBottom: '0.75rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{b.facilitator_services?.title ?? 'Session'}</strong>
              <span className={`pill ${STATUS_PILL[b.status] ?? ''}`}>{b.status.replace(/_/g, ' ')}</span>
            </div>

            <p className="small" style={{ margin: '0.4rem 0 0.2rem' }}>
              {when(b.starts_at)} · {b.client_name || b.client_email}{' '}
              <span className="muted">({b.client_email})</span>
            </p>
            <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
              with {b.facilitators?.display_name ?? 'Unknown'}
              {b.facilitators?.email && <> · {b.facilitators.email}</>}
            </p>

            {/* The split, not just the price — this is the screen where
                "what did we actually keep?" gets asked. */}
            <p className="small mono" style={{ margin: '0 0 0.5rem' }}>
              {b.price_centavos === 0 ? (
                'Complimentary'
              ) : (
                <>
                  {money(b.price_centavos, b.currency)} · Hilom {money(b.platform_fee_centavos)} ·
                  facilitator {money(b.facilitator_net_centavos)}
                </>
              )}
            </p>

            {b.cancellation_reason && (
              <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
                {b.cancelled_by ? `Cancelled by ${b.cancelled_by}: ` : ''}
                <em>{b.cancellation_reason}</em>
              </p>
            )}

            {(b.refund_centavos ?? 0) > 0 && (
              <p className="small" style={{ margin: '0 0 0.5rem' }}>
                {b.refunded_at ? (
                  <span style={{ color: 'var(--forest-dark)' }}>
                    Refunded {money(b.refund_centavos ?? 0)} on{' '}
                    {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(b.refunded_at))}
                    {b.refund_reference && <> · ref {b.refund_reference}</>}
                  </span>
                ) : (
                  <span className="pill pill-warn">{money(b.refund_centavos ?? 0)} refund owed</span>
                )}
              </p>
            )}

            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {b.status === 'confirmed' && isFuture && (
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busyId === b.id}
                  onClick={() => void onCancel(b)}
                >
                  Cancel &amp; refund
                </button>
              )}
              {refundOwed && (
                <button
                  type="button"
                  className="btn btn-accent small"
                  disabled={busyId === b.id}
                  onClick={() => void onMarkRefunded(b)}
                >
                  {busyId === b.id ? 'Recording…' : 'Mark refund sent'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

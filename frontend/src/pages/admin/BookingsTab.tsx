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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarView } from './ui/CalendarView';
import { EmptyState } from './ui/EmptyState';
import { adminToast } from './ui/feedback';
import { Icon } from './ui/Icon';
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
  const [notice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [q, setQ] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);

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
      adminToast.success(`Cancelled. ${money(res.refundCentavos)} is now owed to ${b.client_email}.`);
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
      adminToast.success('Refund recorded.');
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

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = bookings ?? [];
    return needle
      ? list.filter((b) =>
          [b.client_email, b.client_name, b.facilitators?.display_name, b.facilitator_services?.title]
            .some((f) => f?.toLowerCase().includes(needle)),
        )
      : list;
  }, [bookings, q]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Bookings</h2>
          <p className="small muted">Every 1:1 session across facilitators, and the refund ledger.</p>
        </div>
        <div className="page-head__actions">
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
            <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</button>
          </div>
        </div>
      </div>
      <div className="dt__toolbar" style={{ marginBottom: '1rem' }}>
        <div className="dt__search">
          <Icon name="search" size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Client, facilitator, service…" aria-label="Search bookings" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        {bookings && <span className="small muted">{shown.length} of {bookings.length}</span>}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {totalDue > 0 && (
        <div className="alert alert-info">
          <strong>{money(totalDue)}</strong> in refunds is owed and not yet sent.
        </div>
      )}

      {bookings === null &&
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card" style={{ marginBottom: '0.75rem' }} aria-hidden="true">
            <span className="skeleton" style={{ width: '45%', height: '1em' }} />
            <span className="skeleton" style={{ width: '70%', height: '0.85em', marginTop: 8 }} />
          </div>
        ))}
      {bookings !== null && shown.length === 0 && (
        <EmptyState
          icon="clock"
          title={filter === 'refund:due' ? 'No refunds outstanding' : 'Nothing here'}
          body={filter === 'refund:due' ? 'Every promised refund has been sent.' : undefined}
        />
      )}

      {view === 'calendar' && bookings !== null && (
        <div style={{ marginBottom: '1rem' }}>
          <CalendarView
            items={shown.map((b) => ({
              id: b.id,
              at: b.starts_at,
              label: `${b.client_name || b.client_email} · ${b.facilitators?.display_name ?? ''}`,
              tone: b.status.startsWith('cancelled') ? 'bad' : b.status === 'no_show' || b.status === 'pending_payment' ? 'warn' : 'ok',
            }))}
            onPick={(id) => {
              setFocusId(id);
              setView('list');
              window.setTimeout(() => document.getElementById(`booking-${id}`)?.scrollIntoView({ block: 'center' }), 50);
            }}
          />
        </div>
      )}

      {view === 'list' && shown.map((b) => {
        const refundOwed = (b.refund_centavos ?? 0) > 0 && !b.refunded_at;
        const isFuture = new Date(b.starts_at).getTime() > Date.now();

        return (
          <div
            key={b.id}
            id={`booking-${b.id}`}
            className="card"
            style={{ marginBottom: '0.75rem', outline: focusId === b.id ? '2px solid var(--forest)' : undefined }}
          >
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

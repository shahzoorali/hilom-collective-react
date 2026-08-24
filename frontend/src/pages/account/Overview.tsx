/**
 * `/account/overview` — what needs your attention, at a glance.
 *
 * Answers three questions before anything else on the dashboard: is anything
 * overdue, what is the next thing due, and what is coming up. Deliberately
 * not a summary of everything — that is what the other tabs are for — this
 * is the one screen someone should be able to read in five seconds after
 * clicking a reminder email.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import { currentUser } from '../../lib/auth';
import { listMyBookings, viewerTimezone, type Booking } from '../../lib/booking';
import { listMyRegistrations, formatDueDate, isOutstanding, type MyRegistration } from '../../lib/registrations';

export default function Overview() {
  const user = currentUser();
  const [registrations, setRegistrations] = useState<MyRegistration[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([listMyRegistrations(), listMyBookings().catch(() => [])])
      .then(([r, b]) => {
        setRegistrations(r);
        setBookings(b);
      })
      .catch((err: Error) => setError(err.message));
  }, [user]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (registrations === null || bookings === null) return <div className="spinner" aria-label="Loading" />;

  const overdue = registrations.filter((r) =>
    r.charges.some((c) => isOutstanding(c.status) && Date.parse(c.due_at) < Date.now()),
  );
  const overdueIds = new Set(overdue.map((r) => r.id));

  const dueSoon = registrations
    .filter((r) => r.status === 'confirmed' && r.nextChargeId && !overdueIds.has(r.id))
    .map((r) => ({ r, charge: r.charges.find((c) => c.id === r.nextChargeId)! }))
    .filter(({ charge }) => charge !== undefined)
    .sort((a, b) => Date.parse(a.charge.due_at) - Date.parse(b.charge.due_at));

  const now = Date.now();
  const zone = viewerTimezone();
  const upcomingBookings = bookings
    .filter((b) => b.status === 'confirmed' && new Date(b.starts_at).getTime() > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  return (
    <div>
      <h1>Welcome back{user?.givenName ? `, ${user.givenName}` : ''}</h1>

      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <div className="small muted">Places held</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
            {registrations.filter((r) => r.status === 'confirmed' || r.status === 'pending_payment').length}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="small muted">Overdue payments</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: overdue.length > 0 ? 'var(--danger)' : undefined }}>
            {overdue.length}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="small muted">Upcoming sessions</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{upcomingBookings.length}</div>
        </div>
      </div>

      {overdue.length > 0 && (
        <div className="panel">
          <strong style={{ color: 'var(--danger)' }}>Needs a payment</strong>
          {overdue.map((r) => (
            <p key={r.id} className="small" style={{ margin: '8px 0 0' }}>
              <Link to={`/account/registrations/${r.id}`}>{r.events?.title ?? 'Event'}</Link> —{' '}
              {money(r.outstandingCentavos, r.currency)} outstanding
            </p>
          ))}
        </div>
      )}

      {dueSoon.length > 0 && (
        <div className="panel">
          <strong>Coming up</strong>
          {dueSoon.slice(0, 5).map(({ r, charge }) => (
            <p key={charge.id} className="small" style={{ margin: '8px 0 0' }}>
              <Link to={`/account/registrations/${r.id}`}>{r.events?.title ?? 'Event'}</Link> — {charge.label},{' '}
              {money(charge.amount_centavos, charge.currency)}, due {formatDueDate(charge.due_at)}
            </p>
          ))}
        </div>
      )}

      {upcomingBookings.length > 0 && (
        <div className="panel">
          <strong>Your next session</strong>
          <p className="small" style={{ margin: '8px 0 0' }}>
            {upcomingBookings[0]!.facilitator_services?.title ?? 'Session'} —{' '}
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(
              new Date(upcomingBookings[0]!.starts_at),
            )}
          </p>
        </div>
      )}

      {overdue.length === 0 && dueSoon.length === 0 && upcomingBookings.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>Nothing needs your attention right now.</p>
        </div>
      )}
    </div>
  );
}

/**
 * `/account/registrations` — the events you have a place at.
 *
 * Nested under `AccountDashboard`, which owns the sign-in gate — this
 * component can assume a signed-in user.
 *
 * Deliberately thin: each card answers "am I confirmed, what do I owe, and
 * when is the next payment", and everything else lives one click away in
 * RegistrationDetail. This is a list someone scans, not a list they read.
 *
 * Expired holds are filtered out server-side rather than shown greyed — an
 * abandoned checkout is not something anyone wants listed back at them as
 * though it were a booking.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import {
  listMyRegistrations,
  formatDueDate,
  formatEventDates,
  isOutstanding,
  type MyRegistration,
} from '../../lib/registrations';

export default function RegistrationsTab() {
  const [registrations, setRegistrations] = useState<MyRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyRegistrations()
      .then(setRegistrations)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div>
      <h1>Your retreats &amp; events</h1>

      {error && <div className="alert alert-error">{error}</div>}
      {registrations === null && !error && <div className="spinner" aria-label="Loading" />}

      {registrations?.length === 0 && (
        <div className="panel">
          <p style={{ marginTop: 0 }}>You have not registered for anything yet.</p>
          <Link className="btn btn-accent" to="/events">
            See what is coming up
          </Link>
        </div>
      )}

      <div style={{ display: 'grid', gap: 14 }}>
        {(registrations ?? []).map((r) => (
          <RegistrationCard key={r.id} registration={r} />
        ))}
      </div>
    </div>
  );
}

function RegistrationCard({ registration }: { registration: MyRegistration }) {
  const ev = registration.events;
  const next = registration.charges.filter((c) => isOutstanding(c.status)).sort((a, b) => a.seq - b.seq)[0];

  return (
    <Link
      to={`/account/registrations/${registration.id}`}
      className="card"
      style={{ padding: 0, overflow: 'hidden', display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ display: 'flex', gap: 0 }}>
        {ev?.image_url && <img src={ev.image_url} alt="" style={{ width: 120, objectFit: 'cover', flexShrink: 0 }} />}
        <div style={{ padding: 14, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
            <strong>{ev?.title ?? 'Event'}</strong>
            <StatusPill registration={registration} />
          </div>

          {ev && (
            <div className="small muted">
              {formatEventDates(ev.starts_at, ev.ends_at)}
              {ev.location && ` · ${ev.location}`}
            </div>
          )}

          <div className="small" style={{ marginTop: 8 }}>
            {registration.fullySettled ? (
              <>Paid in full — {money(registration.total_centavos, registration.currency)}</>
            ) : (
              <>
                {money(registration.paidCentavos, registration.currency)} paid ·{' '}
                <strong>{money(registration.outstandingCentavos, registration.currency)} left</strong>
                {next && !next.is_deposit && <> · next due {formatDueDate(next.due_at)}</>}
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function StatusPill({ registration }: { registration: MyRegistration }) {
  if (registration.status === 'cancelled') return <span className="pill pill-bad">Cancelled</span>;
  if (registration.status === 'pending_payment') return <span className="pill pill-warn">Holding</span>;
  if (registration.status === 'completed') return <span className="pill">Attended</span>;

  const overdue = registration.charges.some((c) => isOutstanding(c.status) && Date.parse(c.due_at) < Date.now());
  if (overdue) return <span className="pill pill-bad">Payment overdue</span>;

  return <span className="pill pill-ok">Confirmed</span>;
}

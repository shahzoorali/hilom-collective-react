import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminGetOverview, type AdminOverview } from '../../lib/cms';
import { money } from '../../components/Layout';

/**
 * The admin landing page.
 *
 * Seven queues, each a count with a link straight to the filtered view that
 * works it — see docs/admin-dashboard-plan.md §1 for why these seven and not
 * a report. A zero renders muted rather than being hidden, so a quiet
 * dashboard reads as "nothing to do" rather than "broken".
 */
interface QueueCard {
  label: string;
  count: number;
  to: string;
  hint: string;
}

export default function DashboardTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminGetOverview(adminKey)
      .then((r) => {
        if (!cancelled) setOverview(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adminKey]);

  if (loading) {
    return (
      <div className="panel">
        <p className="muted">Loading dashboard…</p>
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="panel">
        <div className="alert alert-error">{error ?? 'Could not load the dashboard.'}</div>
      </div>
    );
  }

  const q = overview.queues;
  const cards: QueueCard[] = [
    {
      label: 'Facilitator applications',
      count: q.facilitatorApplications,
      to: '/admin/facilitators',
      hint: 'awaiting review',
    },
    {
      label: 'Reviews',
      count: q.reviewsPending,
      to: '/admin/reviews',
      hint: 'awaiting moderation',
    },
    {
      label: 'Event proposals',
      count: q.eventProposals,
      to: '/admin/events?status=submitted',
      hint: 'awaiting approval',
    },
    {
      label: 'Class refunds',
      count: q.classRefundsOwed,
      to: '/admin/payouts',
      hint: 'owed',
    },
    {
      label: 'Booking refunds',
      count: q.bookingRefundsOwed,
      to: '/admin/bookings',
      hint: 'owed',
    },
    {
      label: 'Registration instalments',
      count: q.overdueRegistrations,
      to: '/admin/registrations?filter=overdue',
      hint: 'overdue',
    },
    {
      label: 'Orders',
      count: q.stuckOrders,
      to: '/admin/orders?status=paid_pending_enrollment',
      hint: 'paid, not fulfilled',
    },
  ];

  const totalOpen = cards.reduce((acc, c) => acc + c.count, 0);

  return (
    <div>
      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0, marginBottom: '0.25rem' }}>Dashboard</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {totalOpen === 0
            ? 'Nothing needs you right now.'
            : `${totalOpen} thing${totalOpen === 1 ? '' : 's'} waiting on a human.`}
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {cards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => navigate(card.to)}
            className="panel"
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              border: card.count > 0 ? '1px solid var(--forest-dark)' : undefined,
            }}
          >
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                lineHeight: 1,
                color: card.count > 0 ? undefined : 'var(--muted)',
              }}
            >
              {card.count}
            </div>
            <div style={{ fontWeight: 600, marginTop: '0.4rem' }}>{card.label}</div>
            <div className="small muted">{card.hint}</div>
          </button>
        ))}
      </div>

      <div className="panel">
        <h3 style={{ fontSize: '1rem', marginTop: 0, marginBottom: '0.25rem' }}>
          Last {overview.money.days} days
        </h3>
        <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
          Money in, gross — refunds are handled by hand and are not subtracted here.
        </p>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1.5rem',
            alignItems: 'baseline',
            marginBottom: '0.75rem',
          }}
        >
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>
            {money(overview.money.totalCentavos, overview.money.currency)}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.5rem' }}>
          {overview.money.bySource.map((line) => (
            <div key={line.source} className="small" style={{ color: line.count > 0 ? undefined : 'var(--muted)' }}>
              {line.label}: {money(line.centavos, overview.money.currency)}
              {line.count > 0 ? ` (${line.count})` : ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminGetOverview, type AdminOverview } from '../../lib/cms';
import { adminListOrders, type AdminOrder } from '../../lib/api';
import { money } from '../../components/Layout';
import { Skeleton } from '../../components/Skeleton';
import { BarList, Sparkline, dailyBuckets } from './ui/Charts';
import { Icon } from './ui/Icon';

/**
 * The admin landing page.
 *
 * Top to bottom, in the order an operator's morning goes:
 *
 *  1. **Health strip** — is anything on fire? Stuck course orders (paid, not
 *     enrolled) and enrolment failures are the two states that mean a customer
 *     paid and got nothing, so they lead.
 *  2. **Queues** — the seven counts from docs/admin-dashboard-plan.md §1, each
 *     linking to the filtered view that works it. A zero renders muted rather
 *     than hidden, so a quiet dashboard reads as "nothing to do", not "broken".
 *  3. **Money** — gross in over 7 and 30 days (all sources, from the overview
 *     endpoint), and a daily chart plus top products for course sales (from the
 *     orders ledger, which is the only source with per-sale timestamps here).
 */
interface QueueCard {
  label: string;
  count: number;
  to: string;
  hint: string;
}

/** An order row exists only once PayMongo has captured the money (order_status,
 *  0001), so every status counts toward gross — refunds are manual and, like the
 *  overview endpoint, are not subtracted. */
const isPaid = (o: AdminOrder) => o.status !== 'pending';

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
};

export default function DashboardTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [month, setMonth] = useState<AdminOverview | null>(null);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    setError(null);
    adminGetOverview(adminKey, 7)
      .then((r) => !cancelled && setOverview(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    adminGetOverview(adminKey, 30)
      .then((r) => !cancelled && setMonth(r))
      .catch(() => {});
    adminListOrders(adminKey)
      .then((r) => !cancelled && setOrders(r))
      .catch(() => !cancelled && setOrders([]));
    return () => {
      cancelled = true;
    };
  }, [adminKey, refreshedAt]);

  const sales = useMemo(() => {
    if (!orders) return null;
    const paid = orders.filter(isPaid);
    const days = dailyBuckets(paid, (o) => o.created_at, (o) => o.amount_centavos, 30);
    const byProduct = new Map<string, { value: number; count: number }>();
    const since = Date.now() - 30 * 86400000;
    for (const o of paid) {
      if (new Date(o.created_at).getTime() < since) continue;
      const k = o.product_name ?? 'Unknown product';
      const cur = byProduct.get(k) ?? { value: 0, count: 0 };
      byProduct.set(k, { value: cur.value + o.amount_centavos, count: cur.count + 1 });
    }
    const top = [...byProduct]
      .map(([label, v]) => ({ label, value: v.value, hint: `${v.count} sold` }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
    const stuck = orders.filter((o) => o.status === 'paid_pending_enrollment');
    const stuckLong = stuck.filter((o) => Date.now() - new Date(o.updated_at).getTime() > 10 * 60000);
    const failed = orders.filter((o) => o.status === 'failed');
    const noSso = paid.filter((o) => !o.cognito_user_sub && o.status !== 'refunded');
    const last7 = days.slice(-7).reduce((a, d) => a + d.value, 0);
    const prev7 = days.slice(-14, -7).reduce((a, d) => a + d.value, 0);
    const recent = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6);
    return { days, top, stuck, stuckLong, failed, noSso, last7, prev7, recent };
  }, [orders]);

  if (error) {
    return (
      <div className="panel">
        <div className="alert alert-error">{error}</div>
        <button type="button" className="btn btn-ghost small" onClick={() => setRefreshedAt(new Date())}>
          Try again
        </button>
      </div>
    );
  }

  const q = overview?.queues;
  const cards: QueueCard[] = q
    ? [
        { label: 'Facilitator applications', count: q.facilitatorApplications, to: '/admin/facilitators', hint: 'awaiting review' },
        { label: 'Reviews', count: q.reviewsPending, to: '/admin/reviews', hint: 'awaiting moderation' },
        { label: 'Event proposals', count: q.eventProposals, to: '/admin/events?status=submitted', hint: 'awaiting approval' },
        { label: 'Class refunds', count: q.classRefundsOwed, to: '/admin/payouts', hint: 'owed' },
        { label: 'Booking refunds', count: q.bookingRefundsOwed, to: '/admin/bookings', hint: 'owed' },
        { label: 'Registration instalments', count: q.overdueRegistrations, to: '/admin/registrations?filter=overdue', hint: 'overdue' },
        { label: 'Orders', count: q.stuckOrders, to: '/admin/orders?status=paid_pending_enrollment', hint: 'paid, not fulfilled' },
      ]
    : [];
  const totalOpen = cards.reduce((acc, c) => acc + c.count, 0);
  const cur = overview?.money.currency ?? 'PHP';
  const delta = sales && sales.prev7 > 0 ? Math.round(((sales.last7 - sales.prev7) / sales.prev7) * 100) : null;
  const greeting = (() => {
    const h = Number(new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }).format(new Date()));
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>{greeting}</h2>
          <p className="small muted">
            {!overview
              ? 'Loading…'
              : totalOpen === 0
                ? 'Nothing needs you right now.'
                : `${totalOpen} thing${totalOpen === 1 ? '' : 's'} waiting on a human.`}
          </p>
        </div>
        <div className="page-head__actions">
          <span className="kbd-hint">Updated {refreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <button type="button" className="btn btn-ghost small" onClick={() => setRefreshedAt(new Date())}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* 1. Health */}
      <div className="health" aria-label="System health">
        {sales == null ? (
          <Skeleton width={320} height={30} radius={999} />
        ) : (
          <>
            <HealthItem
              tone={sales.stuckLong.length ? 'bad' : sales.stuck.length ? 'warn' : 'ok'}
              label={
                sales.stuck.length
                  ? `${sales.stuck.length} paid order${sales.stuck.length === 1 ? '' : 's'} awaiting enrolment`
                  : 'Enrolment pipeline clear'
              }
              onClick={sales.stuck.length ? () => navigate('/admin/orders?status=paid_pending_enrollment') : undefined}
            />
            <HealthItem
              tone={sales.failed.length ? 'bad' : 'ok'}
              label={sales.failed.length ? `${sales.failed.length} order${sales.failed.length === 1 ? '' : 's'} with errors` : 'No order errors'}
              onClick={sales.failed.length ? () => navigate('/admin/orders?status=failed') : undefined}
            />
            <HealthItem
              tone={sales.noSso.length ? 'warn' : 'ok'}
              label={sales.noSso.length ? `${sales.noSso.length} buyer${sales.noSso.length === 1 ? '' : 's'} without an SSO account` : 'Every buyer has an account'}
              onClick={sales.noSso.length ? () => navigate('/admin/orders?view=nosso') : undefined}
            />
            <HealthItem
              tone={orders && orders.length && Date.now() - new Date(sales.recent[0]?.created_at ?? 0).getTime() > 14 * 86400000 ? 'warn' : 'ok'}
              label={sales.recent[0] ? `Last order ${ago(sales.recent[0].created_at)} ago` : 'No orders yet'}
            />
          </>
        )}
      </div>

      {/* 2. KPIs */}
      <div className="stat-grid">
        <Stat label="Gross, last 7 days" value={overview ? money(overview.money.totalCentavos, cur) : null} hint="All sources" />
        <Stat label="Gross, last 30 days" value={month ? money(month.money.totalCentavos, cur) : null} hint="All sources" />
        <Stat
          label="Course sales, 7 days"
          value={sales ? money(sales.last7, cur) : null}
          hint={
            delta == null ? (
              'vs. previous 7 days'
            ) : (
              <>
                <span className={delta >= 0 ? 'stat__delta--up' : 'stat__delta--down'}>
                  {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
                </span>{' '}
                vs. previous 7 days
              </>
            )
          }
          chart={sales ? <Sparkline values={sales.days.map((d) => d.value)} width={180} height={30} label="Daily course sales, 30 days" /> : null}
        />
        <Stat
          label="Open queues"
          value={overview ? String(totalOpen) : null}
          hint={totalOpen ? 'items need attention' : 'all clear'}
          tone={totalOpen ? 'attention' : undefined}
        />
      </div>

      {/* 3. Queues */}
      <div className="stat-grid">
        {!overview
          ? Array.from({ length: 7 }).map((_, i) => (
              <div className="stat" key={i}>
                <Skeleton width="60%" />
                <Skeleton width={48} height={28} />
              </div>
            ))
          : cards.map((card) => (
              <button
                key={card.label}
                type="button"
                onClick={() => navigate(card.to)}
                className={`stat ${card.count > 0 ? 'stat--attention' : ''}`}
              >
                <span className="stat__label">{card.label}</span>
                <span className={`stat__value ${card.count > 0 ? '' : 'stat__value--muted'}`}>{card.count}</span>
                <span className="stat__hint">
                  {card.hint} {card.count > 0 && <Icon name="arrow" size={12} />}
                </span>
              </button>
            ))}
      </div>

      {/* 4. Money */}
      <div className="dash-grid">
        <div className="dash-card">
          <h3>Course sales — last 30 days</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Daily gross from the orders ledger (Manila days). Hover a bar for the day.
          </p>
          {sales ? <RevenueChart days={sales.days} currency={cur} /> : <Skeleton height={160} />}
        </div>
        <div className="dash-card">
          <h3>Top products — 30 days</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Course orders only.
          </p>
          {sales == null ? (
            <Skeleton height={140} />
          ) : sales.top.length ? (
            <BarList items={sales.top} format={(v) => money(v, cur)} />
          ) : (
            <p className="small muted">No course sales in the last 30 days.</p>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <div className="dash-card">
          <h3>Money in by source — {overview?.money.days ?? 7} days</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Gross — refunds are handled by hand and are not subtracted here.
          </p>
          {overview ? (
            <BarList
              items={overview.money.bySource.map((l) => ({
                label: l.label,
                value: l.centavos,
                hint: l.count ? `${l.count}` : undefined,
              }))}
              format={(v) => money(v, cur)}
            />
          ) : (
            <Skeleton height={120} />
          )}
        </div>
        <div className="dash-card">
          <h3>Latest orders</h3>
          {sales == null ? (
            <Skeleton height={140} />
          ) : sales.recent.length === 0 ? (
            <p className="small muted">No orders yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }}>
              {sales.recent.map((o) => (
                <li key={o.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0', borderBottom: '1px solid var(--line)' }}>
                  <button type="button" className="btn-link small" style={{ textAlign: 'left', textDecoration: 'none' }} onClick={() => navigate(`/admin/orders?q=${o.id}`)}>
                    {o.buyer_email}
                    <span className="muted"> · {o.product_name ?? '—'}</span>
                  </button>
                  <span className="small" style={{ whiteSpace: 'nowrap' }}>
                    {money(o.amount_centavos, o.currency)} <span className="muted">{ago(o.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function HealthItem({ tone, label, onClick }: { tone: 'ok' | 'warn' | 'bad'; label: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="health__dot" aria-hidden="true" />
      {label}
    </>
  );
  return onClick ? (
    <button type="button" className={`health__item health__item--${tone}`} onClick={onClick} style={{ cursor: 'pointer', font: 'inherit', fontSize: '0.82rem', fontWeight: 600, color: 'inherit' }}>
      {inner}
    </button>
  ) : (
    <span className={`health__item health__item--${tone}`}>{inner}</span>
  );
}

function Stat({
  label,
  value,
  hint,
  chart,
  tone,
}: {
  label: string;
  value: string | null;
  hint?: React.ReactNode;
  chart?: React.ReactNode;
  tone?: 'attention';
}) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <span className="stat__label">{label}</span>
      {value == null ? <Skeleton width={120} height={28} /> : <span className="stat__value">{value}</span>}
      {chart}
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

function RevenueChart({ days, currency }: { days: { day: string; value: number }[]; currency: string }) {
  const W = 600;
  const H = 160;
  const pad = 18;
  const max = Math.max(...days.map((d) => d.value), 1);
  const bw = W / days.length;
  const total = days.reduce((a, d) => a + d.value, 0);
  if (total === 0) return <p className="small muted">No course sales in the last 30 days.</p>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="revenue-chart" role="img" aria-label={`Course sales, 30 days, total ${money(total, currency)}`} preserveAspectRatio="none">
      {days.map((d, i) => {
        const h = (d.value / max) * (H - pad * 2);
        return (
          <rect key={d.day} x={i * bw + 2} y={H - pad - h} width={Math.max(bw - 4, 1)} height={Math.max(h, d.value ? 2 : 0)} rx={2}>
            <title>
              {new Date(`${d.day}T00:00:00+08:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}: {money(d.value, currency)}
            </title>
          </rect>
        );
      })}
      <text x={0} y={H - 3}>
        {days[0] && new Date(`${days[0].day}T00:00:00+08:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}
      </text>
      <text x={W} y={H - 3} textAnchor="end">
        Today
      </text>
      <text x={0} y={10}>
        {money(max, currency)}
      </text>
    </svg>
  );
}

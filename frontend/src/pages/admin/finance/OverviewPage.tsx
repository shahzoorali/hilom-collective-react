import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { finance, monthLabel, type FinanceOverview } from '../../../lib/finance';
import { BarList } from '../ui/Charts';
import { Icon } from '../ui/Icon';
import { Delta, ErrorNote, Kpi, MonthBars, SeverityPill, php, pct } from './shared';

export default function OverviewPage({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    finance.overview(adminKey).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey]);
  useEffect(load, [load]);

  const c = data?.current;
  const p = data?.previous;
  const cov = data?.kpis.ledger_coverage;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Finance</h2>
          <p className="small muted">
            {data ? `${monthLabel(data.month)} to date · accrual basis (by event / session date) · test payments excluded` : 'Loading…'}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn-ghost small" onClick={load}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="Gross sales (GMV)" value={c ? php(c.gross_sales) : null} hint={c && p ? <Delta now={c.gross_sales} before={p.gross_sales} /> : undefined} />
        <Kpi
          label="Hilom net revenue"
          value={c ? php(c.net_revenue) : null}
          hint={c ? `Take rate ${pct(c.hilom_share, c.gross_sales)} after facilitator shares` : undefined}
        />
        <Kpi
          label="Net profit"
          value={c ? <span className={c.net_profit < 0 ? 'stat__delta--down' : ''}>{php(c.net_profit)}</span> : null}
          hint={c && p ? <Delta now={c.net_profit} before={p.net_profit} /> : undefined}
          onClick={() => navigate('/admin/finance/pnl')}
        />
        <Kpi
          label="PayMongo fees"
          value={c ? php(c.paymongo_fees) : null}
          hint={c ? (c.fees_unknown_count ? `${c.fees_unknown_count} payment(s) not yet fetched` : `${pct(c.paymongo_fees, c.gross_sales)} of gross`) : undefined}
        />
      </div>

      <div className="stat-grid">
        <Kpi
          label="Owed to facilitators"
          value={data ? php(data.kpis.facilitator_owed_centavos) : null}
          hint="Net of offline payments"
          onClick={() => navigate('/admin/finance/payables')}
        />
        <Kpi
          label="Refunds owed"
          value={data ? php(data.kpis.refunds_owed_centavos) : null}
          hint={data ? `${data.kpis.refunds_owed_count} decided, not sent` : undefined}
          tone={data && data.kpis.refunds_owed_count > 0 ? 'attention' : undefined}
          onClick={() => navigate('/admin/finance/payables')}
        />
        <Kpi
          label="Cash across accounts"
          value={data ? (data.kpis.accounts_count ? php(data.kpis.cash_on_hand_centavos) : 'Set up') : null}
          hint={data?.kpis.accounts_count ? `${data.kpis.accounts_count} account(s), book balance` : 'Add bank / GCash / cash accounts'}
          onClick={() => navigate('/admin/finance/accounts')}
        />
        <Kpi
          label="In PayMongo, not paid out"
          value={data ? php(data.kpis.paymongo_pending_payout_centavos) : null}
          hint="Net of fees, awaiting a PayMongo payout"
          onClick={() => navigate('/admin/finance/reconciliation')}
        />
        <Kpi
          label="Needs attention"
          value={data ? String(data.exceptions.total) : null}
          hint={data ? `${data.exceptions.high} high severity` : undefined}
          tone={data && data.exceptions.high > 0 ? 'alert' : data && data.exceptions.total > 0 ? 'attention' : undefined}
          onClick={() => navigate('/admin/finance/reconciliation')}
        />
      </div>

      <div className="dash-grid">
        <div className="dash-card">
          <h3>Six-month trend</h3>
          <div className="fin-legend" style={{ marginBottom: '0.5rem' }}>
            <span><i style={{ background: 'var(--leaf)', opacity: 0.45 }} />Net revenue</span>
            <span><i style={{ background: 'var(--forest)' }} />Net profit</span>
          </div>
          {data && (
            <MonthBars
              data={data.trend.map((t) => ({
                label: monthLabel(t.month).slice(0, 3),
                value: t.net_profit,
                secondary: t.net_revenue,
              }))}
            />
          )}
        </div>
        <div className="dash-card">
          <h3>Sales mix this month</h3>
          <p className="small muted" style={{ marginTop: 0 }}>Gross by category, Hilom share after.</p>
          {c && c.by_category.length ? (
            <BarList items={c.by_category.map((k) => ({ label: k.category, value: k.gross, hint: `Hilom ${php(k.hilom)} · ${k.count}` }))} format={php} />
          ) : (
            <p className="small muted">No sales yet this month.</p>
          )}
        </div>
      </div>

      <div className="dash-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>Needs attention</h3>
          <button type="button" className="btn btn-ghost small" onClick={() => navigate('/admin/finance/reconciliation')}>
            All {data?.exceptions.total ?? ''} →
          </button>
        </div>
        {data && data.exceptions.top.length === 0 && <p className="small muted">Books reconcile — nothing outstanding.</p>}
        {data?.exceptions.top.map((e) => (
          <div className="fin-exc" key={e.key}>
            <SeverityPill s={e.severity} />
            <div className="fin-exc__body">
              <div className="fin-exc__title">{e.title}</div>
              <div className="small muted">{e.detail}</div>
            </div>
            {e.amount_centavos !== undefined && <span className="fin-num">{php(e.amount_centavos)}</span>}
          </div>
        ))}
        {cov && cov.payments > cov.with_fee && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            PayMongo fees captured for {cov.with_fee} of {cov.payments} payments. Fill the rest from Reconciliation → “Fetch from PayMongo”.
          </p>
        )}
      </div>
    </div>
  );
}

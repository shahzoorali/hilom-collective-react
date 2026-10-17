import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { finance, monthLabel, shiftMonth, thisMonth, type Adjustment, type Basis, type Pnl } from '../../../lib/finance';
import { adminConfirm, adminToast } from '../ui/feedback';
import { ErrorNote, php, pct } from './shared';

type PnlResponse = Awaited<ReturnType<typeof finance.pnl>>;

/**
 * The monthly statement — the workbook's "Profit & Loss" sheet, with a prior
 * month column, an accrual/cash toggle, adjustments and month close.
 */
export default function PnlPage({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? thisMonth();
  const basis: Basis = params.get('basis') === 'cash' ? 'cash' : 'accrual';
  const [data, setData] = useState<PnlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdj, setShowAdj] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setData(null);
    finance.pnl(adminKey, month, basis).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey, month, basis]);
  useEffect(load, [load]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  const closed = data?.period.status === 'closed';
  const canClose = month < thisMonth();

  async function close() {
    const ok = await adminConfirm({
      title: `Close ${monthLabel(month)}?`,
      body: `Freezes this month's figures as they stand. Expenses and adjustments dated in ${monthLabel(month)} are then refused; later corrections go into an open month as adjustments, and any drift in derived sales shows up on Reconciliation.`,
      confirmLabel: 'Close month',
    });
    if (!ok) return;
    try {
      await finance.closePeriod(adminKey, month);
      adminToast.success(`${monthLabel(month)} closed`);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not close');
    }
  }

  async function reopen() {
    const reason = window.prompt(`Reopen ${monthLabel(month)}. Reason (kept in the audit log):`);
    if (!reason) return;
    try {
      await finance.reopenPeriod(adminKey, month, reason);
      adminToast.success(`${monthLabel(month)} reopened`);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not reopen');
    }
  }

  function print() {
    window.print();
  }

  const p = data?.pnl;
  const prev = data?.previous;
  const drill = (q: string) => navigate(`/admin/finance/sales?${q}`);
  const salesQuery = `from=${month}-01&to=${month}-31&basis=${basis === 'accrual' ? 'accrual' : 'cash'}`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Profit &amp; loss — {monthLabel(month)}</h2>
          <p className="small muted">
            {basis === 'accrual'
              ? 'Accrual: sales count in the month the event or session happens; refunds when decided.'
              : 'Cash: sales count when paid; refunds only once sent.'}{' '}
            {closed && data?.period.closed_at && (
              <span className="pill pill-ok">Closed {new Date(data.period.closed_at).toLocaleDateString('en-PH')} by {data.period.closed_by}</span>
            )}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn-ghost small" onClick={print}>Print</button>
          {closed ? (
            <button type="button" className="btn btn-ghost small" onClick={reopen}>Reopen month</button>
          ) : (
            <button type="button" className="btn small" onClick={close} disabled={!canClose} title={canClose ? undefined : 'A month can be closed once it has ended'}>
              Close month
            </button>
          )}
        </div>
      </div>

      <div className="fin-toolbar">
        <button type="button" className="btn btn-ghost small" onClick={() => set('month', shiftMonth(month, -1))}>‹ {monthLabel(shiftMonth(month, -1))}</button>
        <input type="month" value={month} onChange={(e) => e.target.value && set('month', e.target.value)} aria-label="Month" />
        <button type="button" className="btn btn-ghost small" onClick={() => set('month', shiftMonth(month, 1))}>{monthLabel(shiftMonth(month, 1))} ›</button>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Basis">
          <button type="button" aria-pressed={basis === 'accrual'} onClick={() => set('basis', 'accrual')}>Accrual</button>
          <button type="button" aria-pressed={basis === 'cash'} onClick={() => set('basis', 'cash')}>Cash</button>
        </div>
      </div>

      {error && <ErrorNote error={error} onRetry={load} />}
      {p && p.fees_unknown_count > 0 && (
        <div className="alert alert-warning">
          {p.fees_unknown_count} payment(s) this month have no PayMongo fee captured yet, so payment costs are understated. Fetch them on Reconciliation.
        </div>
      )}
      {closed && data?.period.snapshot && p && data.period.snapshot.net_profit !== p.net_profit && (
        <div className="alert alert-error">
          This month closed at a net profit of {php(data.period.snapshot.net_profit)} but now recomputes to {php(p.net_profit)}. Something underneath changed after close — see Reconciliation.
        </div>
      )}

      <div className="dash-card">
        {!p || !prev ? (
          <p className="muted">Loading…</p>
        ) : (
          <table className="pnl">
            <thead>
              <tr>
                <th>Line</th>
                <th>{monthLabel(month)}</th>
                <th>{monthLabel(shiftMonth(month, -1))}</th>
                <th>% of gross</th>
              </tr>
            </thead>
            <tbody>
              <Section label="Sales" />
              <Row label="Gross sales (GMV)" now={p.gross_sales} before={prev.gross_sales} gross={p.gross_sales} onClick={() => drill(salesQuery)} hint={`${p.sales_count} sales`} />
              <Row sub label="Less facilitator shares" now={-p.facilitator_share} before={-prev.facilitator_share} gross={p.gross_sales} />
              <Row total label="Hilom share of sales" now={p.hilom_share} before={prev.hilom_share} gross={p.gross_sales} />
              {p.by_category.map((c) => (
                <Row key={c.category} sub label={c.category} now={c.hilom} before={prev.by_category.find((x) => x.category === c.category)?.hilom ?? 0} gross={p.gross_sales} hint={`${c.count} · gross ${php(c.gross)}`} onClick={() => drill(`${salesQuery}&category=${encodeURIComponent(c.category)}`)} />
              ))}
              <Row sub label="Less refunds (Hilom portion)" now={-p.refunds_hilom} before={-prev.refunds_hilom} gross={p.gross_sales} onClick={() => navigate('/admin/finance/payables')} />
              {(p.revenue_adjustments !== 0 || prev.revenue_adjustments !== 0) && <Row sub label="Revenue adjustments" now={p.revenue_adjustments} before={prev.revenue_adjustments} gross={p.gross_sales} />}
              <Row total label="Net revenue" now={p.net_revenue} before={prev.net_revenue} gross={p.gross_sales} />

              <Section label="Payment costs" />
              <Row sub label="PayMongo fees (incl. VAT)" now={-p.paymongo_fees} before={-prev.paymongo_fees} gross={p.gross_sales} hint={p.fees_unknown_count ? `${p.fees_unknown_count} not captured` : undefined} />
              <Row sub label="Fees recovered from facilitator payouts" now={p.fees_recovered} before={prev.fees_recovered} gross={p.gross_sales} />
              {(p.payment_cost_adjustments !== 0 || prev.payment_cost_adjustments !== 0) && <Row sub label="Payment cost adjustments" now={p.payment_cost_adjustments} before={prev.payment_cost_adjustments} gross={p.gross_sales} />}
              <Row total label="Gross profit" now={p.gross_profit} before={prev.gross_profit} gross={p.gross_sales} />

              <Section label="Operating expenses" />
              {p.opex.map((o) => (
                <Row key={o.key} sub label={o.label} now={-o.centavos} before={-(prev.opex.find((x) => x.key === o.key)?.centavos ?? 0)} gross={p.gross_sales} hint={o.count ? `${o.count} item(s)` : undefined} onClick={o.count ? () => navigate(`/admin/finance/expenses?month=${month}&category=${encodeURIComponent(o.label)}`) : undefined} muted={o.centavos === 0} />
              ))}
              <Row total label="Total operating expenses" now={-p.opex_total} before={-prev.opex_total} gross={p.gross_sales} />
              {(p.other_adjustments !== 0 || prev.other_adjustments !== 0) && <Row sub label="Other adjustments" now={p.other_adjustments} before={prev.other_adjustments} gross={p.gross_sales} />}
              <Row grand label="Net profit / (loss)" now={p.net_profit} before={prev.net_profit} gross={p.gross_sales} />
            </tbody>
          </table>
        )}
      </div>

      <div className="dash-card" style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>Adjustments — {monthLabel(month)}</h3>
          {!closed && (
            <button type="button" className="btn btn-ghost small" onClick={() => setShowAdj((s) => !s)}>
              {showAdj ? 'Cancel' : '+ Add adjustment'}
            </button>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          For what the platform cannot see — an off-platform sale, a bank charge, a correction to a closed month. Positive adds to profit, negative is a cost. Immutable: void and re-enter to change one.
        </p>
        {showAdj && <AdjustmentForm adminKey={adminKey} month={month} onDone={() => { setShowAdj(false); load(); }} />}
        <AdjustmentList adminKey={adminKey} rows={data?.adjustments ?? []} closed={closed} onChange={load} />
      </div>
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <tr className="pnl-section">
      <td colSpan={4}>{label}</td>
    </tr>
  );
}

function Row({
  label,
  now,
  before,
  gross,
  sub,
  total,
  grand,
  hint,
  muted,
  onClick,
}: {
  label: ReactNode;
  now: number;
  before: number;
  gross: number;
  sub?: boolean;
  total?: boolean;
  grand?: boolean;
  hint?: string;
  muted?: boolean;
  onClick?: () => void;
}) {
  const cls = [sub && 'pnl-sub', total && 'pnl-total', grand && 'pnl-grand', onClick && 'pnl-click', muted && 'row-muted'].filter(Boolean).join(' ');
  return (
    <tr className={cls} onClick={onClick}>
      <td>
        {label}
        {hint && <span className="small muted"> · {hint}</span>}
      </td>
      <td className={`n ${now < 0 ? 'neg' : ''}`}>{php(now)}</td>
      <td className="n muted">{php(before)}</td>
      <td className="n muted">{pct(now, gross)}</td>
    </tr>
  );
}

function AdjustmentForm({ adminKey, month, onDone }: { adminKey: string; month: string; onDone: () => void }) {
  const [line, setLine] = useState('opex');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await finance.createAdjustment(adminKey, { month, line, amount_centavos: Math.round(Number(amount) * 100), reason });
      adminToast.success('Adjustment posted');
      onDone();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not post');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <div className="fin-form">
        <label>
          Line
          <select value={line} onChange={(e) => setLine(e.target.value)}>
            <option value="revenue">Revenue</option>
            <option value="payment_costs">Payment costs</option>
            <option value="opex">Operating expenses</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Amount (₱, negative = cost)
          <input type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-500.00" />
        </label>
        <label className="wide">
          Reason
          <input required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bank charge on Sep 30 transfer to Batara" />
        </label>
      </div>
      <div className="fin-form-actions">
        <button className="btn small" disabled={busy || !amount || Number(amount) === 0}>Post adjustment</button>
      </div>
    </form>
  );
}

function AdjustmentList({ adminKey, rows, closed, onChange }: { adminKey: string; rows: Adjustment[]; closed: boolean; onChange: () => void }) {
  if (!rows.length) return <p className="small muted">None.</p>;
  async function voidOne(a: Adjustment) {
    if (!(await adminConfirm({ title: 'Void this adjustment?', body: `${php(a.amount_centavos)} — ${a.reason}`, danger: true, confirmLabel: 'Void' }))) return;
    try {
      await finance.voidAdjustment(adminKey, a.id);
      onChange();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not void');
    }
  }
  return (
    <table className="pnl">
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} className={a.voided_at ? 'row-muted' : ''}>
            <td>
              <span className="pill">{a.line.replace('_', ' ')}</span> {a.reason}
              <div className="small muted">
                {a.created_by} · {new Date(a.created_at).toLocaleDateString('en-PH')}
                {a.voided_at && ' · voided'}
              </div>
            </td>
            <td className={`n ${a.amount_centavos < 0 ? 'neg' : ''}`} style={a.voided_at ? { textDecoration: 'line-through' } : undefined}>{php(a.amount_centavos)}</td>
            <td className="n">
              {!a.voided_at && !closed && (
                <button type="button" className="btn btn-ghost small" onClick={() => voidOne(a)}>Void</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type { Pnl };

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { finance, manilaDay, shiftMonth, thisMonth, type RevenueFilters, type RevenueResponse, type RevenueRow } from '../../../lib/finance';
import { DataTable, type Column } from '../ui/DataTable';
import { adminToast } from '../ui/feedback';
import { ErrorNote, Kpi, SOURCE_LABEL, SOURCE_PATH, php } from './shared';

const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) => manilaDay(new Date(Date.parse(`${shiftMonth(m, 1)}-01T00:00:00+08:00`) - 1).toISOString());

/**
 * The sales register — the workbook's "Sales Register" sheet, derived. One row
 * per paid charge, with the split the platform actually applied and the fee
 * PayMongo actually took.
 */
export default function SalesPage({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const m = thisMonth();
  const filters: RevenueFilters = {
    from: params.get('from') ?? monthStart(m),
    to: params.get('to') ?? monthEnd(m),
    basis: (params.get('basis') as RevenueFilters['basis']) ?? 'cash',
    category: params.get('category') ?? undefined,
    facilitator: params.get('facilitator') ?? undefined,
    status: params.get('status') ?? undefined,
    tests: params.get('tests') ?? undefined,
  };
  const key = JSON.stringify(filters);
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setData(null);
    finance.revenue(adminKey, JSON.parse(key) as RevenueFilters).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey, key]);
  useEffect(load, [load]);

  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const setMonth = (month: string) => {
    const next = new URLSearchParams(params);
    next.set('from', monthStart(month));
    next.set('to', monthEnd(month));
    setParams(next, { replace: true });
  };

  async function toggleTest(r: RevenueRow) {
    if (!r.paymongo_payment_id) return;
    try {
      await finance.setTest(adminKey, r.paymongo_payment_id, !r.is_test);
      adminToast.success(r.is_test ? 'Counted as a real sale again' : 'Marked as a test payment — excluded from P&L');
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not update');
    }
  }

  const columns = useMemo<Column<RevenueRow>[]>(
    () => [
      {
        key: 'when',
        header: 'Paid',
        pinned: true,
        sortValue: (r) => r.occurred_at,
        csv: (r) => r.occurred_at,
        render: (r) => (
          <span className="fin-num" title={`Service date ${manilaDay(r.service_date)}`}>
            {new Date(r.occurred_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        ),
      },
      {
        key: 'buyer',
        header: 'Buyer',
        sortValue: (r) => r.buyer_name ?? r.buyer_email ?? '',
        csv: (r) => r.buyer_email,
        render: (r) => (
          <div>
            <div>{r.buyer_name ?? '—'}</div>
            <div className="small muted">{r.buyer_email}</div>
          </div>
        ),
      },
      {
        key: 'item',
        header: 'Item',
        sortValue: (r) => r.item,
        csv: (r) => r.item,
        render: (r) => (
          <div>
            <div>{r.item}</div>
            <div className="small muted">
              {r.category}
              {r.facilitator_name ? ` · ${r.facilitator_name}` : ''}
            </div>
          </div>
        ),
      },
      { key: 'gross', header: 'Gross', align: 'right', sortValue: (r) => r.gross_centavos, csv: (r) => r.gross_centavos / 100, render: (r) => <span className="fin-num">{php(r.gross_centavos)}</span> },
      {
        key: 'fee',
        header: 'PayMongo fee',
        align: 'right',
        sortValue: (r) => r.fee_centavos ?? -1,
        csv: (r) => (r.fee_centavos === null ? '' : r.fee_centavos / 100),
        render: (r) =>
          r.fee_centavos === null ? (
            <span className="muted" title="Not fetched from PayMongo yet">—</span>
          ) : (
            <span className="fin-num" title={r.method ?? undefined}>
              {php(r.fee_centavos)}
              {r.method && <span className="small muted"> · {r.method}</span>}
            </span>
          ),
      },
      {
        key: 'hilom',
        header: 'Hilom',
        align: 'right',
        sortValue: (r) => r.hilom_share_centavos,
        csv: (r) => r.hilom_share_centavos / 100,
        render: (r) => (
          <span className="fin-num">
            {php(r.hilom_share_centavos)}
            {r.split_missing && (
              <span className="pill pill-warn" style={{ marginLeft: 4 }} title="Facilitator event with no split set — counted as 100% Hilom">
                no split
              </span>
            )}
          </span>
        ),
      },
      { key: 'fac', header: 'Facilitator', align: 'right', sortValue: (r) => r.facilitator_share_centavos, csv: (r) => r.facilitator_share_centavos / 100, render: (r) => <span className="fin-num">{r.facilitator_share_centavos ? php(r.facilitator_share_centavos) : '—'}</span> },
      {
        key: 'status',
        header: 'Status',
        sortValue: (r) => (r.refund ? (r.refund.sent_at ? 'refunded' : 'refund owed') : r.payout_status ?? 'paid'),
        csv: (r) => (r.refund ? (r.refund.sent_at ? 'refunded' : 'refund owed') : r.payout_status ?? 'paid'),
        render: (r) => (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {r.refund ? (
              <span className={r.refund.sent_at ? 'pill' : 'pill pill-bad'}>{r.refund.sent_at ? `refunded ${php(r.refund.centavos)}` : `refund owed ${php(r.refund.centavos)}`}</span>
            ) : (
              <span className="pill pill-ok">paid</span>
            )}
            {r.payout_status && <span className="pill">payout {r.payout_status}</span>}
            {r.is_test && <span className="pill pill-warn" title={r.test_reason ?? undefined}>test</span>}
          </span>
        ),
      },
      { key: 'source', header: 'Source', defaultHidden: true, sortValue: (r) => r.source, csv: (r) => r.source, render: (r) => SOURCE_LABEL[r.source] ?? r.source },
      { key: 'payment', header: 'PayMongo id', defaultHidden: true, csv: (r) => r.paymongo_payment_id, render: (r) => <span className="fin-mono">{r.paymongo_payment_id ?? '—'}</span> },
      { key: 'payout', header: 'PayMongo payout', defaultHidden: true, csv: (r) => r.paymongo_payout_id, render: (r) => <span className="fin-mono">{r.paymongo_payout_id ?? '—'}</span> },
    ],
    [],
  );

  const t = data?.totals;
  const month = filters.from?.slice(0, 7) ?? m;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Sales register</h2>
          <p className="small muted">Every paid charge across courses, events, classes and sessions — derived, never typed in.</p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn-ghost small"
            onClick={() => finance.revenueCsv(adminKey, filters).catch((e: Error) => adminToast.error(e.message))}
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="fin-toolbar">
        <button type="button" className="btn btn-ghost small" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
        <button type="button" className="btn btn-ghost small" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
        <label>From <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label>To <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} /></label>
        <div className="seg" role="group" aria-label="Date basis">
          <button type="button" aria-pressed={filters.basis === 'cash'} onClick={() => set('basis', 'cash')} title="When the money landed">Paid date</button>
          <button type="button" aria-pressed={filters.basis === 'accrual'} onClick={() => set('basis', 'accrual')} title="When the event / session happens">Service date</button>
        </div>
        <select value={filters.category ?? ''} onChange={(e) => set('category', e.target.value || undefined)} aria-label="Category">
          <option value="">All categories</option>
          {data?.categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={filters.facilitator ?? ''} onChange={(e) => set('facilitator', e.target.value || undefined)} aria-label="Facilitator">
          <option value="">All facilitators</option>
          <option value="none">Hilom-run only</option>
          {data?.facilitators.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value || undefined)} aria-label="Status">
          <option value="">Any status</option>
          <option value="paid">Paid (not refunded)</option>
          <option value="refunded">Refunded / refund owed</option>
          <option value="split_missing">No revenue split</option>
        </select>
        <label><input type="checkbox" checked={filters.tests === '1'} onChange={(e) => set('tests', e.target.checked ? '1' : undefined)} /> Include tests</label>
      </div>

      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="Sales" value={t ? String(t.count) : null} />
        <Kpi label="Gross" value={t ? php(t.gross_centavos) : null} />
        <Kpi label="PayMongo fees" value={t ? php(t.fee_centavos) : null} hint="Captured fees only" />
        <Kpi label="Hilom share" value={t ? php(t.hilom_share_centavos) : null} />
        <Kpi label="Facilitator share" value={t ? php(t.facilitator_share_centavos) : null} />
      </div>

      <DataTable<RevenueRow>
        id="finance-sales"
        rows={data?.rows ?? null}
        loading={!data && !error}
        rowKey={(r) => `${r.source}:${r.source_id}`}
        columns={columns}
        searchText={(r) => [r.buyer_name, r.buyer_email, r.item, r.facilitator_name, r.paymongo_payment_id].join(' ')}
        searchPlaceholder="Search buyer, item, payment id…"
        defaultSort={{ key: 'when', dir: 'desc' }}
        csvName="hilom-sales-view"
        pageSize={50}
        expand={(r) => (
          <div className="small" style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Service date <b>{manilaDay(r.service_date)}</b></span>
            {r.net_centavos !== null && <span>PayMongo net <b>{php(r.net_centavos)}</b></span>}
            {r.paymongo_payment_id && <span className="fin-mono">{r.paymongo_payment_id}</span>}
            {r.paymongo_payout_id && <span>Payout <span className="fin-mono">{r.paymongo_payout_id}</span></span>}
            <button type="button" className="btn btn-ghost small" onClick={() => navigate(SOURCE_PATH[r.source] ?? '/admin')}>
              Open {SOURCE_LABEL[r.source] ?? 'source'} →
            </button>
            {r.paymongo_payment_id && (
              <button type="button" className="btn btn-ghost small" onClick={() => toggleTest(r)}>
                {r.is_test ? 'Not a test — count it' : 'Mark as test payment'}
              </button>
            )}
          </div>
        )}
        empty={{ title: 'No sales in this range', body: 'Widen the dates or clear a filter.' }}
      />
      {data?.truncated && <p className="small muted">Showing the first 2,000 rows — narrow the range or use the CSV export for everything.</p>}
    </div>
  );
}

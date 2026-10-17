import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { finance, type Payables } from '../../../lib/finance';
import { DataTable } from '../ui/DataTable';
import { ErrorNote, Kpi, SOURCE_LABEL, SOURCE_PATH, php } from './shared';

/**
 * What Hilom owes: facilitator shares not yet paid, refunds decided but not
 * sent, and clawbacks due. Building and paying a batch stays on the Payouts
 * screen — this is the balance sheet view of the same money.
 */
export default function PayablesPage({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Payables | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    finance.payables(adminKey).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey]);
  useEffect(load, [load]);

  const owed = data?.refunds.filter((r) => !r.refunded_at) ?? [];
  const sum = (f: (x: Payables['facilitators'][number]) => number) => (data ? data.facilitators.reduce((s, x) => s + f(x), 0) : 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Payables &amp; refunds</h2>
          <p className="small muted">Money held for someone else. Pay facilitators from the Payouts screen; mark refunds sent from the sale's own screen.</p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn-ghost small" onClick={() => navigate('/admin/finance/transactions')}>Record an offline payment</button>
          <button type="button" className="btn small" onClick={() => navigate('/admin/payouts')}>Go to Payouts →</button>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="Owed to facilitators" value={data ? php(sum((x) => Math.max(0, x.net_owed_centavos))) : null} hint="After offline payments" />
        <Kpi label="Not yet batched" value={data ? php(sum((x) => x.unbatched_centavos)) : null} hint="Platform shares on paid sales" />
        <Kpi label="Batched, unpaid" value={data ? php(sum((x) => x.batched_unpaid_centavos)) : null} hint="Draft or approved payouts" />
        <Kpi label="Clawback due" value={data ? php(sum((x) => x.clawback_due_centavos)) : null} tone={sum((x) => x.clawback_due_centavos) > 0 ? 'attention' : undefined} hint="Refunded after payout" />
        <Kpi label="Refunds owed" value={data ? php(owed.reduce((s, r) => s + r.refund_centavos, 0)) : null} tone={owed.length ? 'alert' : undefined} hint={`${owed.length} not sent`} />
      </div>

      <h3 style={{ fontSize: '1rem' }}>By facilitator</h3>
      <DataTable
        id="finance-payables"
        rows={data?.facilitators ?? null}
        loading={!data && !error}
        rowKey={(r) => r.facilitator_id}
        columns={[
          { key: 'name', header: 'Facilitator', pinned: true, sortValue: (r) => r.name, csv: (r) => r.name },
          { key: 'rate', header: 'Default rate', align: 'right', sortValue: (r) => r.platform_fee_bps ?? -1, render: (r) => (r.platform_fee_bps === null ? '—' : `${r.platform_fee_bps / 100}%`) },
          { key: 'unbatched', header: 'Not batched', align: 'right', sortValue: (r) => r.unbatched_centavos, csv: (r) => r.unbatched_centavos / 100, render: (r) => <span className="fin-num">{php(r.unbatched_centavos)} <span className="small muted">· {r.unbatched_count}</span></span> },
          { key: 'batched', header: 'Batched, unpaid', align: 'right', sortValue: (r) => r.batched_unpaid_centavos, csv: (r) => r.batched_unpaid_centavos / 100, render: (r) => <span className="fin-num">{php(r.batched_unpaid_centavos)}</span> },
          { key: 'claw', header: 'Clawback due', align: 'right', sortValue: (r) => r.clawback_due_centavos, csv: (r) => r.clawback_due_centavos / 100, render: (r) => <span className="fin-num">{r.clawback_due_centavos ? php(r.clawback_due_centavos) : '—'}</span> },
          { key: 'offline', header: 'Offline sales share', align: 'right', defaultHidden: false, sortValue: (r) => r.offline_owed_centavos, csv: (r) => r.offline_owed_centavos / 100, render: (r) => <span className="fin-num">{r.offline_owed_centavos ? php(r.offline_owed_centavos) : '—'}</span> },
          { key: 'paidoff', header: 'Paid offline', align: 'right', sortValue: (r) => r.paid_offline_centavos, csv: (r) => r.paid_offline_centavos / 100, render: (r) => <span className="fin-num">{r.paid_offline_centavos ? `(${php(r.paid_offline_centavos)})` : '—'}</span> },
          { key: 'net', header: 'Balance owed', align: 'right', sortValue: (r) => r.net_owed_centavos, csv: (r) => r.net_owed_centavos / 100, render: (r) => <b className={`fin-num ${r.net_owed_centavos < 0 ? 'stat__delta--up' : ''}`} title={r.net_owed_centavos < 0 ? 'Paid ahead — credit' : undefined}>{r.net_owed_centavos < 0 ? `credit ${php(-r.net_owed_centavos)}` : php(r.net_owed_centavos)}</b> },
          { key: 'paid', header: 'Batches paid', defaultHidden: true, align: 'right', sortValue: (r) => r.paid_total_centavos, csv: (r) => r.paid_total_centavos / 100, render: (r) => <span className="fin-num">{php(r.paid_total_centavos)}</span> },
          { key: 'receipt', header: '', render: (r) => <button type="button" className="btn btn-ghost small" onClick={(e) => { e.stopPropagation(); navigate(`/admin/finance/receipts?facilitator=${r.facilitator_id}`); }}>Receipt</button> },
          { key: 'last', header: 'Last paid', sortValue: (r) => r.last_paid_at ?? '', render: (r) => (r.last_paid_at ? new Date(r.last_paid_at).toLocaleDateString('en-PH') : '—') },
        ]}
        defaultSort={{ key: 'net', dir: 'desc' }}
        csvName="hilom-facilitator-payables"
        empty={{ title: 'Nothing owed to facilitators' }}
      />

      {data && data.offline_payments.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>Paid outside payout batches</h3>
          <div className="dash-card">
            {data.offline_payments.map((t) => (
              <div className="fin-exc" key={t.id}>
                <span className="pill">{t.occurred_on}</span>
                <div className="fin-exc__body">
                  <div className="fin-exc__title">{t.facilitator_name}</div>
                  <div className="small muted">{[t.item, t.reference && `ref ${t.reference}`].filter(Boolean).join(' · ')}</div>
                </div>
                <span className="fin-num">{php(t.amount_centavos)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>Refunds</h3>
      <DataTable
        id="finance-refunds"
        urlPrefix="r_"
        rows={data?.refunds ?? null}
        loading={!data && !error}
        rowKey={(r) => `${r.source}:${r.source_id}`}
        columns={[
          { key: 'state', header: 'State', pinned: true, sortValue: (r) => (r.refunded_at ? 1 : 0), render: (r) => (r.refunded_at ? <span className="pill pill-ok">sent {new Date(r.refunded_at).toLocaleDateString('en-PH')}</span> : <span className="pill pill-bad">owed</span>) },
          { key: 'item', header: 'Item', sortValue: (r) => r.item, csv: (r) => r.item, render: (r) => <div>{r.item}<div className="small muted">{SOURCE_LABEL[r.source] ?? r.source}{r.facilitator_name ? ` · ${r.facilitator_name}` : ''}</div></div> },
          { key: 'buyer', header: 'Buyer', sortValue: (r) => r.buyer_email ?? '', csv: (r) => r.buyer_email },
          { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.refund_centavos, csv: (r) => r.refund_centavos / 100, render: (r) => <span className="fin-num">{php(r.refund_centavos)}</span> },
          { key: 'decided', header: 'Decided', sortValue: (r) => r.decided_at, render: (r) => new Date(r.decided_at).toLocaleDateString('en-PH') },
        ]}
        onRowClick={(r) => navigate(SOURCE_PATH[r.source] ?? '/admin')}
        defaultSort={{ key: 'state', dir: 'asc' }}
        csvName="hilom-refunds"
        empty={{ title: 'No refunds recorded' }}
      />

      <h3 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>Payout batches</h3>
      <DataTable
        id="finance-payout-batches"
        urlPrefix="p_"
        rows={data?.payouts ?? null}
        loading={!data && !error}
        rowKey={(r) => r.id}
        columns={[
          { key: 'fac', header: 'Facilitator', pinned: true, sortValue: (r) => r.facilitator_name ?? '', csv: (r) => r.facilitator_name },
          { key: 'period', header: 'Period', sortValue: (r) => r.period_end, render: (r) => `${new Date(r.period_start).toLocaleDateString('en-PH')} – ${new Date(r.period_end).toLocaleDateString('en-PH')}` },
          { key: 'status', header: 'Status', sortValue: (r) => r.status, csv: (r) => r.status, render: (r) => <span className={r.status === 'paid' ? 'pill pill-ok' : r.status === 'void' ? 'pill' : 'pill pill-warn'}>{r.status}</span> },
          { key: 'gross', header: 'Gross', align: 'right', sortValue: (r) => r.gross_centavos, render: (r) => php(r.gross_centavos) },
          { key: 'fee', header: 'Hilom fee', align: 'right', sortValue: (r) => r.platform_fee_centavos, render: (r) => php(r.platform_fee_centavos) },
          { key: 'proc', header: 'Processing', align: 'right', sortValue: (r) => r.processing_fee_centavos, render: (r) => php(r.processing_fee_centavos) },
          { key: 'net', header: 'Net', align: 'right', sortValue: (r) => r.net_centavos, csv: (r) => r.net_centavos / 100, render: (r) => <b className="fin-num">{php(r.net_centavos)}</b> },
          { key: 'ref', header: 'Reference', csv: (r) => r.reference, render: (r) => r.reference ?? '—' },
        ]}
        onRowClick={() => navigate('/admin/payouts')}
        defaultSort={{ key: 'period', dir: 'desc' }}
        csvName="hilom-payout-batches"
        empty={{ title: 'No payout batches yet' }}
      />
    </div>
  );
}

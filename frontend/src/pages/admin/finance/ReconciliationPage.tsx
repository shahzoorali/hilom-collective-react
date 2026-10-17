import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { finance, type FinanceException, type Reconciliation } from '../../../lib/finance';
import { adminToast } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { ErrorNote, Kpi, SOURCE_PATH, SeverityPill, php } from './shared';

const KIND_LABEL: Record<string, string> = {
  refund_owed: 'Refunds owed',
  refund_after_payout: 'Refunded after payout',
  duplicate_charge: 'Possible duplicates',
  fee_missing: 'PayMongo fee missing',
  ledger_orphan: 'Unmatched PayMongo payments',
  amount_mismatch: 'Amount mismatches',
  split_missing: 'Missing revenue split',
  expense_future: 'Future-dated expenses',
  expense_no_receipt: 'Expenses without receipts',
  closed_period_changed: 'Closed month drift',
  reimbursement_owed: 'Reimbursements owed',
};

/**
 * Every check the workbook review did by hand, run on every load: refunds not
 * sent, duplicates, missing fees and splits, drift in closed months. An
 * acknowledged item stays hidden until its numbers change.
 */
export default function ReconciliationPage({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Reconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAcked, setShowAcked] = useState(false);
  const [kind, setKind] = useState<string>('');
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    finance.reconciliation(adminKey, showAcked).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey, showAcked]);
  useEffect(load, [load]);

  async function sync(missingOnly: boolean) {
    let total = 0;
    const failures: string[] = [];
    try {
      for (let guard = 0; guard < 40; guard++) {
        setSyncing(`Fetching from PayMongo… ${total} done`);
        const r = await finance.refreshLedger(adminKey, { missing: missingOnly });
        total += r.refreshed;
        failures.push(...r.failed.map((f) => `${f.id}: ${f.error}`));
        if (r.remaining === 0 || r.refreshed + r.failed.length === 0) break;
      }
      if (failures.length) adminToast.error(`${total} fetched, ${failures.length} failed — ${failures[0]}`);
      else adminToast.success(`${total} payment(s) fetched from PayMongo`);
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setSyncing(null);
      load();
    }
  }

  async function ack(e: FinanceException) {
    const note = window.prompt(`Acknowledge “${e.title}”.\nNote (why this is fine / what was done):`, '');
    if (note === null) return;
    try {
      await finance.ack(adminKey, e.key, note);
      load();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not acknowledge');
    }
  }

  async function unack(e: FinanceException) {
    try {
      await finance.ack(adminKey, e.key, '', true);
      load();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not restore');
    }
  }

  const exceptions = (data?.exceptions ?? []).filter((e) => !kind || e.kind === kind);
  const counts = new Map<string, number>();
  for (const e of data?.exceptions ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Reconciliation</h2>
          <p className="small muted">What doesn't add up, recomputed live from the books and PayMongo.</p>
        </div>
        <div className="page-head__actions">
          {syncing ? (
            <span className="kbd-hint">{syncing}</span>
          ) : (
            <>
              <button type="button" className="btn btn-ghost small" onClick={() => sync(true)}>
                <Icon name="download" size={14} /> Fetch missing fees
              </button>
              <button type="button" className="btn btn-ghost small" onClick={() => sync(false)} title="Also refresh payments not yet in a PayMongo payout">
                <Icon name="refresh" size={14} /> Refresh from PayMongo
              </button>
            </>
          )}
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="Open items" value={data ? String(data.exceptions.filter((e) => !e.ack).length) : null} tone={data?.exceptions.some((e) => e.severity === 'high' && !e.ack) ? 'alert' : undefined} />
        <Kpi label="Ledger rows" value={data ? String(data.ledger.rows) : null} hint="PayMongo payments captured" />
        <Kpi label="Missing fee" value={data ? String(data.ledger.missing_fee) : null} hint={data?.ledger.errors ? `${data.ledger.errors} fetch error(s)` : 'Fetched rows only'} />
        <Kpi label="Test payments" value={data ? String(data.ledger.tests) : null} hint="Excluded from P&L" />
      </div>

      <div className="dash-card">
        <div className="fin-toolbar" style={{ marginBottom: '0.25rem' }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="">All kinds ({data?.exceptions.length ?? 0})</option>
            {[...counts.entries()].map(([k, n]) => (
              <option key={k} value={k}>{KIND_LABEL[k] ?? k} ({n})</option>
            ))}
          </select>
          <span className="spacer" />
          <label><input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} /> Show acknowledged</label>
        </div>
        {data && exceptions.length === 0 && <p className="small muted">Nothing to reconcile. 🌿</p>}
        {exceptions.map((e) => (
          <div className="fin-exc" key={e.key} style={e.ack ? { opacity: 0.6 } : undefined}>
            <SeverityPill s={e.severity} />
            <div className="fin-exc__body">
              <div className="fin-exc__title">{e.title}</div>
              <div className="small muted">{e.detail}</div>
              {e.ack && (
                <div className="small">
                  Acknowledged by {e.ack.acked_by} {new Date(e.ack.acked_at).toLocaleDateString('en-PH')}
                  {e.ack.note ? ` — ${e.ack.note}` : ''}
                </div>
              )}
            </div>
            {e.amount_centavos !== undefined && <span className="fin-num">{php(e.amount_centavos)}</span>}
            <div className="fin-exc__actions">
              {e.link && SOURCE_PATH[e.link.source] && (
                <button type="button" className="btn btn-ghost small" onClick={() => navigate(SOURCE_PATH[e.link!.source]!)}>Open</button>
              )}
              {e.ack ? (
                <button type="button" className="btn btn-ghost small" onClick={() => unack(e)}>Restore</button>
              ) : (
                <button type="button" className="btn btn-ghost small" onClick={() => ack(e)}>Acknowledge</button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="dash-card" style={{ marginTop: '1rem' }}>
        <h3>PayMongo payouts</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          What each PayMongo payout to the bank should contain, from the captured payments. Match the Net column against the bank deposit.
        </p>
        <table className="pnl">
          <thead>
            <tr>
              <th>Payout</th>
              <th>Payments</th>
              <th>Gross</th>
              <th>Fees</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {data?.payout_groups.map((g) => (
              <tr key={g.payout_id ?? 'pending'}>
                <td>
                  {g.payout_id ? <span className="fin-mono">{g.payout_id}</span> : <span className="pill pill-warn">not yet paid out</span>}
                  {g.first && (
                    <div className="small muted">
                      {new Date(g.first).toLocaleDateString('en-PH')} – {new Date(g.last!).toLocaleDateString('en-PH')}
                    </div>
                  )}
                </td>
                <td className="n">{g.count}</td>
                <td className="n">{php(g.gross)}</td>
                <td className="n">{php(-g.fees)}</td>
                <td className="n"><b>{php(g.net)}</b></td>
              </tr>
            ))}
            {data && data.payout_groups.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">No payments captured yet — use “Fetch missing fees”.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

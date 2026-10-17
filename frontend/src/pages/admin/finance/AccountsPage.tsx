import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { finance, monthLabel, type FinanceAccount, type Movement } from '../../../lib/finance';
import { adminToast } from '../ui/feedback';
import { ErrorNote, Kpi, php } from './shared';

type Data = Awaited<ReturnType<typeof finance.accounts>>;

const KIND_LABEL: Record<FinanceAccount['kind'], string> = { bank: 'Bank', ewallet: 'E-wallet', cash: 'Cash', paymongo: 'PayMongo balance' };

/**
 * Where the money is. Book balances are computed from every recorded movement
 * — PayMongo payments and payouts, expenses, reimbursements, facilitator
 * batches and offline transactions. Each month, type in what the statement
 * says; any gap is something unrecorded and shows on Reconciliation.
 */
export default function AccountsPage({ adminKey }: { adminKey: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<FinanceAccount> | null>(null);

  const load = useCallback(() => {
    setError(null);
    finance.accounts(adminKey, selected ?? undefined).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey, selected]);
  useEffect(load, [load]);

  async function statement(a: FinanceAccount, month: string, current: number | null) {
    const raw = window.prompt(`${a.name} — closing balance on the ${monthLabel(month)} statement (₱):`, current === null ? '' : String(current / 100));
    if (raw === null || raw.trim() === '') return;
    const n = Math.round(Number(raw.replace(/,/g, '')) * 100);
    if (!Number.isFinite(n)) return adminToast.error('Not a number');
    try {
      await finance.saveStatement(adminKey, a.id, month, n);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not save');
    }
  }

  const active = data?.accounts.filter((a) => a.is_active) ?? [];
  const total = active.reduce((s, a) => s + (a.balance_centavos ?? 0), 0);
  const gaps = active.flatMap((a) => (a.months ?? []).filter((m) => m.gap_centavos)).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Accounts</h2>
          <p className="small muted">Bank, GCash, cash and the PayMongo balance — book balances from every recorded movement, checked against statements.</p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn small" onClick={() => setEditing({ kind: 'bank', opening_balance_centavos: 0, opening_date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) })}>+ Add account</button>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="Cash across accounts" value={data ? php(total) : null} hint="Book balance today" />
        <Kpi label="Statement gaps" value={data ? String(gaps) : null} tone={gaps ? 'alert' : undefined} hint="Last six months" />
        <Kpi
          label="Not assigned to an account"
          value={data ? String(data.unassigned.expenses + data.unassigned.transactions) : null}
          hint={data ? `${data.unassigned.expenses} expense(s), ${data.unassigned.transactions} transaction(s)` : undefined}
          tone={data && data.unassigned.expenses + data.unassigned.transactions > 0 ? 'attention' : undefined}
        />
      </div>

      {editing && <AccountForm adminKey={adminKey} initial={editing} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}

      {data && data.accounts.length === 0 && !editing && (
        <div className="dash-card">
          <p style={{ marginTop: 0 }}>No accounts yet. A typical setup:</p>
          <ul className="small">
            <li><b>BDO / BPI current account</b> — Bank, “PayMongo pays out here” and “Facilitator payouts are paid from here”.</li>
            <li><b>GCash</b> — E-wallet.</li>
            <li><b>Cash box</b> — Cash, for workshop door sales.</li>
            <li><b>PayMongo</b> — PayMongo balance, opening 0: shows money collected but not yet paid out.</li>
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>Set each opening balance to what the account held on its opening date; everything after that is computed.</p>
        </div>
      )}

      {data?.accounts.map((a) => (
        <div className="dash-card" key={a.id} style={{ marginBottom: '1rem', opacity: a.is_active ? 1 : 0.6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ marginBottom: 0 }}>
                {a.name} <span className="pill">{KIND_LABEL[a.kind]}</span>
                {a.receives_paymongo && <span className="pill pill-ok" style={{ marginLeft: 4 }}>PayMongo payouts</span>}
                {a.default_for_payouts && <span className="pill pill-ok" style={{ marginLeft: 4 }}>Pays facilitators</span>}
                {!a.is_active && <span className="pill" style={{ marginLeft: 4 }}>inactive</span>}
              </h3>
              <div className="small muted">Opening {php(a.opening_balance_centavos)} on {a.opening_date}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="stat__value">{php(a.balance_centavos ?? 0)}</div>
              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost small" onClick={() => setSelected(selected === a.id ? null : a.id)}>{selected === a.id ? 'Hide movements' : 'Movements'}</button>
                <button type="button" className="btn btn-ghost small" onClick={() => setEditing(a)}>Edit</button>
              </div>
            </div>
          </div>
          <table className="pnl" style={{ marginTop: '0.75rem' }}>
            <thead>
              <tr><th>Month end</th><th>Books</th><th>Statement</th><th>Gap</th><th /></tr>
            </thead>
            <tbody>
              {a.months?.map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month)}</td>
                  <td className="n">{php(m.book_centavos)}</td>
                  <td className="n">{m.statement_centavos === null ? <span className="muted">—</span> : php(m.statement_centavos)}</td>
                  <td className={`n ${m.gap_centavos ? 'neg' : ''}`}>{m.gap_centavos === null ? '' : m.gap_centavos === 0 ? '✓' : php(m.gap_centavos)}</td>
                  <td className="n">
                    <button type="button" className="btn btn-ghost small" onClick={() => statement(a, m.month, m.statement_centavos)}>
                      {m.statement_centavos === null ? 'Enter statement' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected === a.id && <Movements rows={data.movements} />}
        </div>
      ))}
    </div>
  );
}

function Movements({ rows }: { rows: Movement[] }) {
  if (!rows.length) return <p className="small muted">No movements recorded.</p>;
  return (
    <table className="pnl" style={{ marginTop: '0.75rem' }}>
      <thead>
        <tr><th>Date</th><th>Movement</th><th>Amount</th></tr>
      </thead>
      <tbody>
        {rows.map((m, i) => (
          <tr key={`${m.source}:${m.source_id}:${i}`}>
            <td>{m.date}{m.approximate && <span className="small muted" title="PayMongo's payout date is not captured; dated on its last payment"> ≈</span>}</td>
            <td>{m.label}</td>
            <td className={`n ${m.amount_centavos < 0 ? 'neg' : ''}`}>{php(m.amount_centavos)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountForm({ adminKey, initial, onDone, onCancel }: { adminKey: string; initial: Partial<FinanceAccount>; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<Partial<FinanceAccount>>(initial);
  const [opening, setOpening] = useState(String((initial.opening_balance_centavos ?? 0) / 100));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FinanceAccount>(k: K, v: FinanceAccount[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await finance.saveAccount(adminKey, f.id ?? null, {
        name: f.name,
        kind: f.kind,
        opening_balance_centavos: Math.round(Number(opening || 0) * 100),
        opening_date: f.opening_date,
        receives_paymongo: !!f.receives_paymongo,
        default_for_payouts: !!f.default_for_payouts,
        is_active: f.is_active ?? true,
        notes: f.notes ?? null,
      });
      adminToast.success('Account saved');
      onDone();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <h3>{f.id ? 'Edit account' : 'New account'}</h3>
      <div className="fin-form">
        <label>Name<input required value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="BDO current ••1234" /></label>
        <label>
          Kind
          <select value={f.kind} onChange={(e) => set('kind', e.target.value as FinanceAccount['kind'])}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Opening balance (₱)<input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} /></label>
        <label>Opening date<input type="date" required value={f.opening_date ?? ''} onChange={(e) => set('opening_date', e.target.value)} /></label>
        <label><span><input type="checkbox" checked={!!f.receives_paymongo} onChange={(e) => set('receives_paymongo', e.target.checked)} /> PayMongo pays out here</span></label>
        <label><span><input type="checkbox" checked={!!f.default_for_payouts} onChange={(e) => set('default_for_payouts', e.target.checked)} /> Facilitator payouts are paid from here</span></label>
        {f.id && <label><span><input type="checkbox" checked={f.is_active ?? true} onChange={(e) => set('is_active', e.target.checked)} /> Active</span></label>}
        <label className="wide">Notes<input value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      <div className="fin-form-actions">
        <button className="btn small" disabled={busy}>Save</button>
        <button type="button" className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

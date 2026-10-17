/**
 * The confirmation card for an expense the assistant drafted.
 *
 * The assistant is read-only: it can only propose. Everything here is the
 * admin's own action — every field is editable, the receipt is uploaded
 * through the Finance receipt upload, and Save calls the same Finance expenses
 * endpoint the Expenses screen uses, under the admin's credentials and audit
 * identity. The outcome is then recorded on the run so the conversation (and
 * the assistant's next answer) knows whether it was saved.
 */
import { useEffect, useState } from 'react';
import { EXPENSE_CATEGORIES, finance } from '../../lib/finance';
import { setExpenseDraftOutcome, type AssistantRun, type ExpenseDraft } from '../../lib/assistant';
import { adminConfirm, adminToast } from './ui/feedback';
import './finance/finance.css';

const peso = (c: number) => `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ExpenseDraftCard({ adminKey, run, onChange }: { adminKey: string; run: AssistantRun; onChange: (r: AssistantRun) => void }) {
  const status = run.expense_draft_status;
  const initial = run.expense_draft?.draft;
  const warnings = (run.expense_draft?.warnings ?? []).filter((w) => !w.startsWith('Attach the receipt'));
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<ExpenseDraft | null>(initial ?? null);
  const [amount, setAmount] = useState(initial ? String(initial.amount_centavos / 100) : '');
  const [vat, setVat] = useState(initial?.vat_centavos ? String(initial.vat_centavos / 100) : '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState<{ accounts: { id: string; name: string; is_active: boolean }[]; events: { id: string; title: string; starts_at: string | null }[] } | null>(null);

  useEffect(() => {
    if (!editing || lists) return;
    Promise.all([finance.accounts(adminKey), finance.expenses(adminKey)])
      .then(([a, e]) => setLists({ accounts: a.accounts, events: e.events }))
      .catch(() => setLists({ accounts: [], events: [] }));
  }, [editing, lists, adminKey]);

  if (!f || !initial) return null;
  const set = <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) => setF({ ...f, [k]: v });
  const personal = f.paid_by.toLowerCase() !== 'company';

  async function save() {
    if (!f) return;
    const amountC = Math.round(Number(amount) * 100);
    if (!f.incurred_on || !f.vendor.trim() || !(amountC > 0)) {
      adminToast.error('Date, vendor and an amount above zero are required');
      return;
    }
    const ok = await adminConfirm({
      title: `Record ${peso(amountC)} to ${f.vendor}?`,
      body: `${f.category}, dated ${f.incurred_on}, ${personal ? `paid personally by ${f.paid_by} (added to what the company owes them)` : f.account_name ? `paid from ${f.account_name}` : 'paid by the company'}${file ? ', with receipt' : ', no receipt attached'}. It goes into the P&L for ${f.incurred_on.slice(0, 7)}.`,
      confirmLabel: 'Save expense',
    });
    if (!ok) return;
    setBusy(true);
    try {
      let receipt = {};
      if (file) {
        const up = await finance.uploadReceipt(adminKey, file);
        receipt = { receipt_key: up.key, receipt_name: up.name };
      }
      const origin = `Drafted with the admin assistant (conversation run ${run.id.slice(0, 8)}).`;
      const { expense } = await finance.saveExpense(adminKey, null, {
        incurred_on: f.incurred_on,
        vendor: f.vendor,
        description: f.description,
        category: f.category,
        amount_centavos: amountC,
        vat_centavos: Math.round(Number(vat || 0) * 100),
        paid_by: personal ? f.paid_by : 'company',
        account_id: personal ? null : f.account_id,
        payment_method: f.payment_method,
        event_id: f.event_id,
        status: 'approved',
        notes: [f.notes, origin].filter(Boolean).join('\n'),
        ...receipt,
      });
      await setExpenseDraftOutcome(adminKey, run.id, 'saved', expense.id);
      onChange({ ...run, expense_draft_status: 'saved', expense_id: expense.id });
      adminToast.success(`Expense recorded: ${f.vendor} ${peso(amountC)}`);
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await setExpenseDraftOutcome(adminKey, run.id, 'cancelled');
      onChange({ ...run, expense_draft_status: 'cancelled' });
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
      <strong>Expense draft — not saved yet</strong>
      {status === 'saved' && <span className="pill pill-ok">Saved to Finance → Expenses</span>}
      {status === 'cancelled' && <span className="pill">Cancelled — nothing recorded</span>}
    </div>
  );

  if (status !== 'pending') {
    return (
      <div className="dash-card" style={{ marginTop: '0.75rem', opacity: status === 'cancelled' ? 0.6 : 1 }}>
        {header}
        <div className="small muted" style={{ marginTop: 4 }}>
          {f.incurred_on} · {f.vendor} · {f.category} · {peso(Math.round(Number(amount) * 100))}
          {status === 'saved' && (
            <>
              {' · '}
              <a href="/admin/finance/expenses" target="_blank" rel="noopener">open Expenses</a>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dash-card" style={{ marginTop: '0.75rem', borderLeft: '4px solid var(--ochre, #c9a24a)' }}>
      {header}
      <p className="small muted" style={{ margin: '0.25rem 0 0.75rem' }}>
        The assistant can't record anything. Check every field, attach the receipt, then Save — it's recorded under your name.
      </p>

      {editing ? (
        <div className="fin-form">
          <label>Date paid<input type="date" value={f.incurred_on} onChange={(e) => set('incurred_on', e.target.value)} /></label>
          <label>Vendor / payee<input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} /></label>
          <label>
            Category
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>Amount (₱)<input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label>VAT included (₱)<input type="number" min="0" step="0.01" value={vat} onChange={(e) => setVat(e.target.value)} /></label>
          <label>Payment method<input value={f.payment_method ?? ''} onChange={(e) => set('payment_method', e.target.value || null)} /></label>
          <label>
            Paid personally by
            <input
              value={personal ? f.paid_by : ''}
              placeholder="Blank = the company paid"
              onChange={(e) => setF({ ...f, paid_by: e.target.value.trim() ? e.target.value : 'company', ...(e.target.value.trim() ? { account_id: null, account_name: null } : {}) })}
            />
          </label>
          {!personal && (
            <label>
              Paid from account
              <select
                value={f.account_id ?? ''}
                onChange={(e) => {
                  const a = lists?.accounts.find((x) => x.id === e.target.value);
                  setF({ ...f, account_id: a?.id ?? null, account_name: a?.name ?? null });
                }}
              >
                <option value="">— not tracked —</option>
                {lists?.accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <label>
            For event
            <select
              value={f.event_id ?? ''}
              onChange={(e) => {
                const ev = lists?.events.find((x) => x.id === e.target.value);
                setF({ ...f, event_id: ev?.id ?? null, event_title: ev?.title ?? null });
              }}
            >
              <option value="">— none —</option>
              {f.event_id && !lists?.events.some((x) => x.id === f.event_id) && <option value={f.event_id}>{f.event_title}</option>}
              {lists?.events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}{ev.starts_at ? ` (${ev.starts_at.slice(0, 10)})` : ''}</option>)}
            </select>
          </label>
          <label className="wide">Description<input value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
          <label className="wide">Notes<input value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} /></label>
        </div>
      ) : (
        <table className="pnl">
          <tbody>
            <tr><td>Date paid</td><td>{f.incurred_on}</td></tr>
            <tr><td>Vendor</td><td>{f.vendor}</td></tr>
            <tr><td>Description</td><td>{f.description || <span className="muted">—</span>}</td></tr>
            <tr><td>Category</td><td>{f.category}</td></tr>
            <tr><td>Amount</td><td><b>{peso(Math.round(Number(amount) * 100))}</b>{Number(vat) ? <span className="muted"> incl. VAT {peso(Math.round(Number(vat) * 100))}</span> : null}</td></tr>
            <tr><td>Paid by</td><td>{personal ? <>{f.paid_by} <span className="pill pill-warn">reimburse</span></> : f.account_name ?? 'Company (no account)'}</td></tr>
            {f.payment_method && <tr><td>Method</td><td>{f.payment_method}</td></tr>}
            {f.event_title && <tr><td>Event</td><td>{f.event_title}</td></tr>}
            {f.notes && <tr><td>Notes</td><td>{f.notes}</td></tr>}
          </tbody>
        </table>
      )}

      {warnings.length > 0 && (
        <ul className="small" style={{ margin: '0.75rem 0 0', paddingLeft: '1.1rem' }}>
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      <div className="fin-form" style={{ marginTop: '0.75rem' }}>
        <label className="wide">
          Receipt (PDF or image)
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>

      <div className="fin-form-actions">
        <button type="button" className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save expense'}</button>
        <button type="button" className="btn btn-ghost small" disabled={busy} onClick={() => setEditing((e) => !e)}>{editing ? 'Done editing' : 'Edit'}</button>
        <button type="button" className="btn btn-ghost small" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

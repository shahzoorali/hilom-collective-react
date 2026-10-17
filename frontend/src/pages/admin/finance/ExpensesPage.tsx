import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EXPENSE_CATEGORIES, finance, thisMonth, type Expense, type Reimbursement } from '../../../lib/finance';
import { DataTable } from '../ui/DataTable';
import { adminConfirm, adminToast } from '../ui/feedback';
import { ErrorNote, Kpi, php } from './shared';

type Events = { id: string; title: string; starts_at: string | null }[];

const blank = (): Partial<Expense> => ({
  incurred_on: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
  vendor: '',
  description: '',
  category: 'Venue / Event Cost',
  amount_centavos: 0,
  vat_centavos: 0,
  paid_by: 'company',
  payment_method: 'Bank Transfer',
  event_id: null,
  status: 'approved',
});

/**
 * Company spending, with receipts, and who fronted it. An expense paid
 * personally ("c/o Crizy" in the workbook) lands on that person's open
 * reimbursement automatically, so what the company owes them is a number
 * rather than a note.
 */
export default function ExpensesPage({ adminKey }: { adminKey: string }) {
  const [params] = useSearchParams();
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [events, setEvents] = useState<Events>([]);
  const [reimb, setReimb] = useState<Reimbursement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Expense> | null>(null);
  const month = params.get('month') ?? '';
  const category = params.get('category') ?? '';

  const load = useCallback(() => {
    setError(null);
    finance
      .expenses(adminKey)
      .then((r) => {
        setRows(r.expenses);
        setEvents(r.events);
      })
      .catch((e: Error) => setError(e.message));
    finance.reimbursements(adminKey).then((r) => setReimb(r.reimbursements)).catch(() => {});
  }, [adminKey]);
  useEffect(load, [load]);

  const visible = (rows ?? []).filter((e) => (!month || e.incurred_on.startsWith(month)) && (!category || e.category === category));
  const live = visible.filter((e) => e.status === 'approved');
  const thisMonthTotal = (rows ?? []).filter((e) => e.status === 'approved' && e.incurred_on.startsWith(thisMonth())).reduce((s, e) => s + e.amount_centavos, 0);
  const owed = reimb.filter((r) => r.status === 'owed');

  async function openReceipt(e: Expense) {
    try {
      const { url } = await finance.receiptUrl(adminKey, e.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not open receipt');
    }
  }

  async function markPaid(r: Reimbursement) {
    const reference = window.prompt(`Mark ${php(r.total_centavos)} to ${r.payee} as paid back.\nTransfer reference:`);
    if (!reference) return;
    try {
      await finance.updateReimbursement(adminKey, r.id, { status: 'paid', reference });
      adminToast.success(`Reimbursement to ${r.payee} recorded`);
      load();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not update');
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Expenses</h2>
          <p className="small muted">
            {month || category ? `Filtered: ${[month, category].filter(Boolean).join(' · ')}` : 'Everything the company spends, with receipts.'}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn small" onClick={() => setEditing(blank())}>+ New expense</button>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="stat-grid">
        <Kpi label="This month" value={rows ? php(thisMonthTotal) : null} hint="Approved expenses" />
        <Kpi label="Shown" value={rows ? php(live.reduce((s, e) => s + e.amount_centavos, 0)) : null} hint={`${live.length} approved`} />
        <Kpi label="Without receipt" value={rows ? String(live.filter((e) => !e.receipt_key).length) : null} tone={live.some((e) => !e.receipt_key) ? 'attention' : undefined} />
        <Kpi label="Owed back to people" value={php(owed.reduce((s, r) => s + r.total_centavos, 0))} hint={owed.map((r) => r.payee).join(', ') || 'Nobody'} tone={owed.length ? 'attention' : undefined} />
      </div>

      {editing && <ExpenseForm adminKey={adminKey} initial={editing} events={events} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}

      <DataTable<Expense>
        id="finance-expenses"
        rows={rows ? visible : null}
        loading={!rows && !error}
        rowKey={(e) => e.id}
        columns={[
          { key: 'date', header: 'Date', pinned: true, sortValue: (e) => e.incurred_on, csv: (e) => e.incurred_on },
          { key: 'vendor', header: 'Vendor', sortValue: (e) => e.vendor, csv: (e) => e.vendor, render: (e) => <div>{e.vendor}<div className="small muted">{e.description}</div></div> },
          { key: 'category', header: 'Category', sortValue: (e) => e.category, csv: (e) => e.category },
          { key: 'amount', header: 'Amount', align: 'right', sortValue: (e) => e.amount_centavos, csv: (e) => e.amount_centavos / 100, render: (e) => <span className="fin-num">{php(e.amount_centavos)}</span> },
          { key: 'paid_by', header: 'Paid by', sortValue: (e) => e.paid_by, csv: (e) => e.paid_by, render: (e) => (e.paid_by === 'company' ? 'Company' : <span>{e.paid_by} <span className="pill pill-warn">reimburse</span></span>) },
          { key: 'method', header: 'Method', defaultHidden: true, csv: (e) => e.payment_method, render: (e) => e.payment_method ?? '—' },
          { key: 'event', header: 'Event', defaultHidden: true, csv: (e) => events.find((x) => x.id === e.event_id)?.title ?? '', render: (e) => events.find((x) => x.id === e.event_id)?.title ?? '—' },
          {
            key: 'receipt',
            header: 'Receipt',
            render: (e) =>
              e.receipt_key ? (
                <button type="button" className="btn btn-ghost small" onClick={(ev) => { ev.stopPropagation(); openReceipt(e); }}>View</button>
              ) : (
                <span className="pill pill-warn">missing</span>
              ),
          },
          { key: 'status', header: 'Status', sortValue: (e) => e.status, csv: (e) => e.status, render: (e) => <span className={e.status === 'approved' ? 'pill pill-ok' : 'pill'}>{e.status}</span> },
        ]}
        onRowClick={(e) => setEditing(e)}
        defaultSort={{ key: 'date', dir: 'desc' }}
        csvName="hilom-expenses"
        searchText={(e) => `${e.vendor} ${e.description} ${e.category} ${e.paid_by}`}
        empty={{ title: 'No expenses recorded', action: <button type="button" className="btn small" onClick={() => setEditing(blank())}>Record the first one</button> }}
      />

      <h3 style={{ fontSize: '1rem', marginTop: '1.5rem' }}>Reimbursements</h3>
      <div className="dash-card">
        {reimb.length === 0 && <p className="small muted">Nobody has paid for anything personally.</p>}
        {reimb.map((r) => (
          <div className="fin-exc" key={r.id}>
            <span className={r.status === 'owed' ? 'pill pill-warn' : r.status === 'paid' ? 'pill pill-ok' : 'pill'}>{r.status}</span>
            <div className="fin-exc__body">
              <div className="fin-exc__title">{r.payee}</div>
              <div className="small muted">
                {r.expenses.map((e) => `${e.incurred_on} ${e.vendor} ${php(e.amount_centavos)}`).join(' · ') || 'No expenses linked'}
                {r.status === 'paid' && r.reference && ` — paid ${r.paid_at ? new Date(r.paid_at).toLocaleDateString('en-PH') : ''}, ref ${r.reference}`}
              </div>
            </div>
            <span className="fin-num">{php(r.total_centavos)}</span>
            <div className="fin-exc__actions">
              {r.status === 'owed' && r.total_centavos > 0 && (
                <button type="button" className="btn small" onClick={() => markPaid(r)}>Mark paid back</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExpenseForm({
  adminKey,
  initial,
  events,
  onCancel,
  onSaved,
}: {
  adminKey: string;
  initial: Partial<Expense>;
  events: Events;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<Partial<Expense>>(initial);
  const [amount, setAmount] = useState(initial.amount_centavos ? String(initial.amount_centavos / 100) : '');
  const [vat, setVat] = useState(initial.vat_centavos ? String(initial.vat_centavos / 100) : '');
  const [personal, setPersonal] = useState(initial.paid_by && initial.paid_by !== 'company' ? initial.paid_by : '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Expense>(k: K, v: Expense[K] | null) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let receipt = {};
      if (file) {
        const up = await finance.uploadReceipt(adminKey, file);
        receipt = { receipt_key: up.key, receipt_name: up.name };
      }
      await finance.saveExpense(adminKey, f.id ?? null, {
        ...f,
        ...receipt,
        amount_centavos: Math.round(Number(amount) * 100),
        vat_centavos: Math.round(Number(vat || 0) * 100),
        paid_by: personal.trim() || 'company',
      });
      adminToast.success(f.id ? 'Expense updated' : 'Expense recorded');
      onSaved();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function voidIt() {
    if (!f.id) return;
    if (!(await adminConfirm({ title: 'Void this expense?', body: 'It stays on record but no longer counts in the P&L.', danger: true, confirmLabel: 'Void' }))) return;
    setBusy(true);
    try {
      await finance.saveExpense(adminKey, f.id, { status: 'void' });
      onSaved();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not void');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <h3>{f.id ? 'Edit expense' : 'New expense'}</h3>
      <div className="fin-form">
        <label>Date paid<input type="date" required value={f.incurred_on ?? ''} onChange={(e) => set('incurred_on', e.target.value)} /></label>
        <label>Vendor / payee<input required value={f.vendor ?? ''} onChange={(e) => set('vendor', e.target.value)} placeholder="Kapitolyo Art Space" /></label>
        <label>
          Category
          <select value={f.category} onChange={(e) => set('category', e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Amount (₱)<input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>VAT included (₱)<input type="number" min="0" step="0.01" value={vat} onChange={(e) => setVat(e.target.value)} placeholder="0.00" /></label>
        <label>Payment method<input value={f.payment_method ?? ''} onChange={(e) => set('payment_method', e.target.value)} placeholder="Bank Transfer / GCash / Card" /></label>
        <label>
          Paid personally by
          <input value={personal} onChange={(e) => setPersonal(e.target.value)} placeholder="Leave blank if the company paid" />
        </label>
        <label>
          For event
          <select value={f.event_id ?? ''} onChange={(e) => set('event_id', e.target.value || null)}>
            <option value="">— none —</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.title}{ev.starts_at ? ` (${ev.starts_at.slice(0, 10)})` : ''}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={f.status} onChange={(e) => set('status', e.target.value as Expense['status'])}>
            <option value="approved">Approved (counts in P&amp;L)</option>
            <option value="draft">Draft / committed, not yet paid</option>
          </select>
        </label>
        <label className="wide">Description<input value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="Incense workshop venue, Oct 17" /></label>
        <label className="wide">
          Receipt (PDF or image) {f.receipt_name && <span className="muted">— current: {f.receipt_name}</span>}
          <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="wide">Notes<textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      {personal.trim() && (
        <p className="small muted">This will be added to what the company owes {personal.trim()}.</p>
      )}
      <div className="fin-form-actions">
        <button className="btn small" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
        <span style={{ flex: 1 }} />
        {f.id && f.status !== 'void' && (
          <button type="button" className="btn btn-ghost small" onClick={voidIt} disabled={busy}>Void</button>
        )}
      </div>
    </form>
  );
}

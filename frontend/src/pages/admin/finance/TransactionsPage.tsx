import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { finance, TRANSACTION_LABEL, type FinanceTransaction, type TransactionKind } from '../../../lib/finance';
import { DataTable } from '../ui/DataTable';
import { adminConfirm, adminToast } from '../ui/feedback';
import { ErrorNote, Kpi, php } from './shared';

type Lists = Awaited<ReturnType<typeof finance.transactions>>;

const SALE_CATEGORIES = ['Self-Paced Course', 'Workshop / Event', 'Group Class', 'Teacher Training', '1:1 Session', 'Other'];

/** What each kind needs from the form. */
const NEEDS: Record<TransactionKind, { counterparty?: string; item?: boolean; facilitator?: 'required' | 'optional'; event?: boolean; counter?: boolean }> = {
  offline_sale: { counterparty: 'Buyer', item: true, facilitator: 'optional', event: true },
  facilitator_payment: { facilitator: 'required', item: true },
  owner_contribution: { counterparty: 'Owner' },
  owner_withdrawal: { counterparty: 'Owner' },
  loan_in: { counterparty: 'Lender' },
  loan_repayment: { counterparty: 'Lender' },
  transfer: { counter: true },
  other_in: { counterparty: 'From', item: true },
  other_out: { counterparty: 'To', item: true },
};

const HELP: Record<TransactionKind, string> = {
  offline_sale: 'Cash, bank transfer or GCash for anything sold outside PayMongo. Split like a platform sale (event rule → facilitator rate) and counted in the P&L and sales register.',
  facilitator_payment: 'Money sent to a facilitator outside a payout batch — an advance, a flat fee, a transfer made before this system. It reduces what they are owed; paying ahead carries as a credit.',
  owner_contribution: 'Owner money put into the business. Not revenue — it shows in account balances only.',
  owner_withdrawal: 'Owner money taken out. Not an expense — it shows in account balances only.',
  loan_in: 'Borrowed money received. Not revenue.',
  loan_repayment: 'Paying back a loan. Not an expense (interest is — record that as an expense).',
  transfer: 'Moving money between your own accounts, e.g. GCash to bank or cash deposited.',
  other_in: 'Money in that is neither a sale nor capital — a deposit refund, a reimbursement from a partner.',
  other_out: 'Money out that is neither an expense nor a payout — a deposit paid, money returned.',
};

/**
 * Money that moves outside the platform. Immutable once posted: void with a
 * reason and re-enter to correct, so the record of what was believed and when
 * survives.
 */
export default function TransactionsPage({ adminKey }: { adminKey: string }) {
  const [data, setData] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<TransactionKind | null>(null);
  const [showVoid, setShowVoid] = useState(false);

  const load = useCallback(() => {
    setError(null);
    finance.transactions(adminKey).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey]);
  useEffect(load, [load]);

  const accountName = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a.name])), [data]);
  const facName = useMemo(() => new Map((data?.facilitators ?? []).map((f) => [f.id, f.display_name])), [data]);
  const rows = (data?.transactions ?? []).filter((t) => showVoid || t.status === 'posted');
  const posted = (data?.transactions ?? []).filter((t) => t.status === 'posted');
  const sum = (k: TransactionKind) => posted.filter((t) => t.kind === k).reduce((s, t) => s + t.amount_centavos, 0);

  async function voidOne(t: FinanceTransaction) {
    const reason = window.prompt(`Void ${TRANSACTION_LABEL[t.kind]} of ${php(t.amount_centavos)}?\nReason (kept on record):`);
    if (!reason) return;
    try {
      await finance.voidTransaction(adminKey, t.id, reason);
      adminToast.success('Voided');
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not void');
    }
  }

  async function openReceipt(t: FinanceTransaction) {
    try {
      window.open((await finance.transactionReceiptUrl(adminKey, t.id)).url, '_blank', 'noopener');
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not open receipt');
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Offline transactions</h2>
          <p className="small muted">Everything that moved outside PayMongo. Expenses have their own page.</p>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="fin-toolbar">
        {(['offline_sale', 'facilitator_payment', 'transfer', 'owner_contribution', 'owner_withdrawal', 'loan_in', 'loan_repayment', 'other_in', 'other_out'] as TransactionKind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'btn small' : 'btn btn-ghost small'} onClick={() => setKind(kind === k ? null : k)}>
            + {TRANSACTION_LABEL[k]}
          </button>
        ))}
      </div>

      {kind && data && (
        <TransactionForm
          key={kind}
          adminKey={adminKey}
          kind={kind}
          lists={data}
          onCancel={() => setKind(null)}
          onSaved={() => {
            setKind(null);
            load();
          }}
        />
      )}

      <div className="stat-grid">
        <Kpi label="Offline sales" value={data ? php(sum('offline_sale')) : null} />
        <Kpi label="Paid to facilitators offline" value={data ? php(sum('facilitator_payment')) : null} />
        <Kpi label="Owner in / out" value={data ? `${php(sum('owner_contribution'))} / ${php(sum('owner_withdrawal'))}` : null} />
        <Kpi label="Loans outstanding" value={data ? php(sum('loan_in') - sum('loan_repayment')) : null} />
      </div>

      <DataTable<FinanceTransaction>
        id="finance-transactions"
        rows={data ? rows : null}
        loading={!data && !error}
        rowKey={(t) => t.id}
        toolbar={<label className="small muted"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Show voided</label>}
        columns={[
          { key: 'date', header: 'Date', pinned: true, sortValue: (t) => t.occurred_on, csv: (t) => t.occurred_on },
          { key: 'kind', header: 'Type', sortValue: (t) => t.kind, csv: (t) => TRANSACTION_LABEL[t.kind], render: (t) => <span className="pill">{TRANSACTION_LABEL[t.kind]}</span> },
          {
            key: 'what',
            header: 'Details',
            csv: (t) => [t.counterparty, t.item].filter(Boolean).join(' — '),
            render: (t) => (
              <div style={t.status === 'void' ? { textDecoration: 'line-through' } : undefined}>
                <div>{[t.counterparty, t.item].filter(Boolean).join(' — ') || '—'}</div>
                <div className="small muted">
                  {t.facilitator_id ? facName.get(t.facilitator_id) : ''}
                  {t.kind === 'offline_sale' && t.facilitator_share_centavos ? ` · facilitator ${php(t.facilitator_share_centavos)}, Hilom ${php(t.hilom_share_centavos)}` : ''}
                  {t.reference ? ` · ref ${t.reference}` : ''}
                  {t.status === 'void' ? ` · void: ${t.void_reason}` : ''}
                </div>
              </div>
            ),
          },
          {
            key: 'account',
            header: 'Account',
            csv: (t) => (t.account_id ? accountName.get(t.account_id) : ''),
            render: (t) =>
              t.kind === 'transfer'
                ? `${accountName.get(t.account_id ?? '') ?? '?'} → ${accountName.get(t.counter_account_id ?? '') ?? '?'}`
                : t.account_id
                  ? accountName.get(t.account_id)
                  : <span className="muted">—</span>,
          },
          { key: 'amount', header: 'Amount', align: 'right', sortValue: (t) => t.amount_centavos, csv: (t) => t.amount_centavos / 100, render: (t) => <span className="fin-num">{php(t.amount_centavos)}</span> },
          {
            key: 'actions',
            header: '',
            render: (t) => (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                {t.receipt_key && <button type="button" className="btn btn-ghost small" onClick={() => openReceipt(t)}>Receipt</button>}
                {t.status === 'posted' && <button type="button" className="btn btn-ghost small" onClick={() => voidOne(t)}>Void</button>}
              </span>
            ),
          },
        ]}
        defaultSort={{ key: 'date', dir: 'desc' }}
        csvName="hilom-offline-transactions"
        searchText={(t) => `${t.counterparty ?? ''} ${t.item ?? ''} ${t.reference ?? ''} ${TRANSACTION_LABEL[t.kind]}`}
        empty={{ title: 'No offline transactions yet', body: 'Use the buttons above to record money that moved outside PayMongo.' }}
      />
    </div>
  );
}

function TransactionForm({
  adminKey,
  kind,
  lists,
  onCancel,
  onSaved,
}: {
  adminKey: string;
  kind: TransactionKind;
  lists: Lists;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const need = NEEDS[kind];
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const [f, setF] = useState<Record<string, string>>({ occurred_on: today, category: 'Group Class' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const activeAccounts = lists.accounts.filter((a) => a.is_active);

  const preview = useMemo(() => {
    if (kind !== 'offline_sale') return null;
    const amount = Math.round(Number(f.amount || 0) * 100);
    if (!amount) return null;
    if (f.hilom_share) return `Hilom ${php(Math.round(Number(f.hilom_share) * 100))}, facilitator ${php(amount - Math.round(Number(f.hilom_share) * 100))} (as entered)`;
    if (f.event_id) return 'Split by the event’s rule or rate, as a PayMongo payment on it would be.';
    const fac = lists.facilitators.find((x) => x.id === f.facilitator_id);
    if (!fac) return `All ${php(amount)} is Hilom’s (no facilitator).`;
    const hilom = Math.floor((amount * fac.platform_fee_bps) / 10000);
    return `Hilom ${php(hilom)} (${fac.platform_fee_bps / 100}%), ${fac.display_name} ${php(amount - hilom)}`;
  }, [kind, f, lists.facilitators]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let receipt = {};
      if (file) {
        const up = await finance.uploadReceipt(adminKey, file);
        receipt = { receipt_key: up.key, receipt_name: up.name };
      }
      await finance.createTransaction(adminKey, {
        kind,
        occurred_on: f.occurred_on,
        amount_centavos: Math.round(Number(f.amount) * 100),
        account_id: f.account_id || null,
        counter_account_id: f.counter_account_id || null,
        counterparty: f.counterparty || null,
        counterparty_email: f.counterparty_email || null,
        item: f.item || null,
        category: kind === 'offline_sale' ? f.category : null,
        facilitator_id: f.facilitator_id || null,
        event_id: f.event_id || null,
        ...(kind === 'offline_sale' && f.hilom_share ? { hilom_share_centavos: Math.round(Number(f.hilom_share) * 100) } : {}),
        payment_method: f.payment_method || null,
        reference: f.reference || null,
        notes: f.notes || null,
        ...receipt,
      });
      adminToast.success(`${TRANSACTION_LABEL[kind]} recorded`);
      onSaved();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (Object.keys(f).length > 2 && !(await adminConfirm('Discard this entry?'))) return;
    onCancel();
  }

  return (
    <form className="dash-card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <h3>{TRANSACTION_LABEL[kind]}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>{HELP[kind]}</p>
      <div className="fin-form">
        <label>Date<input type="date" required value={f.occurred_on} onChange={(e) => set('occurred_on', e.target.value)} /></label>
        <label>Amount (₱)<input type="number" min="0.01" step="0.01" required value={f.amount ?? ''} onChange={(e) => set('amount', e.target.value)} /></label>
        <label>
          {kind === 'transfer' ? 'From account' : TRANSACTION_LABEL[kind].includes('in') || kind === 'offline_sale' || kind === 'loan_in' ? 'Received into' : 'Paid from'}
          <select value={f.account_id ?? ''} onChange={(e) => set('account_id', e.target.value)} required={kind === 'transfer'}>
            <option value="">{activeAccounts.length ? '— not tracked —' : 'Set up accounts first (Accounts page)'}</option>
            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {need.counter && (
          <label>
            To account
            <select required value={f.counter_account_id ?? ''} onChange={(e) => set('counter_account_id', e.target.value)}>
              <option value="">Choose…</option>
              {activeAccounts.filter((a) => a.id !== f.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        {need.counterparty && <label>{need.counterparty}<input value={f.counterparty ?? ''} onChange={(e) => set('counterparty', e.target.value)} /></label>}
        {kind === 'offline_sale' && <label>Buyer email<input type="email" value={f.counterparty_email ?? ''} onChange={(e) => set('counterparty_email', e.target.value)} /></label>}
        {need.facilitator && (
          <label>
            Facilitator{need.facilitator === 'optional' ? ' (if theirs)' : ''}
            <select required={need.facilitator === 'required'} value={f.facilitator_id ?? ''} onChange={(e) => set('facilitator_id', e.target.value)}>
              <option value="">{need.facilitator === 'optional' ? '— Hilom’s own —' : 'Choose…'}</option>
              {lists.facilitators.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}
            </select>
          </label>
        )}
        {need.event && (
          <label>
            Event (optional)
            <select value={f.event_id ?? ''} onChange={(e) => set('event_id', e.target.value)}>
              <option value="">— none —</option>
              {lists.events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}{ev.starts_at ? ` (${ev.starts_at.slice(0, 10)})` : ''}</option>)}
            </select>
          </label>
        )}
        {kind === 'offline_sale' && (
          <label>
            Category
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {SALE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        )}
        {need.item && (
          <label className="wide">
            {kind === 'offline_sale' ? 'What was sold' : 'What for'}
            <input required={kind === 'offline_sale'} value={f.item ?? ''} onChange={(e) => set('item', e.target.value)} placeholder={kind === 'facilitator_payment' ? 'Incense workshop share, Sep 17 – Oct 13' : ''} />
          </label>
        )}
        {kind === 'offline_sale' && (
          <label>
            Hilom share override (₱)
            <input type="number" min="0" step="0.01" value={f.hilom_share ?? ''} onChange={(e) => set('hilom_share', e.target.value)} placeholder="Leave blank to use the rule" />
          </label>
        )}
        <label>Method<input value={f.payment_method ?? ''} onChange={(e) => set('payment_method', e.target.value)} placeholder="Cash / Bank Transfer / GCash" /></label>
        <label>Reference<input value={f.reference ?? ''} onChange={(e) => set('reference', e.target.value)} placeholder="Transfer / OR number" /></label>
        <label className="wide">Receipt / proof (optional)<input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="wide">Notes<textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
      {preview && <p className="small"><b>Split:</b> {preview}</p>}
      <div className="fin-form-actions">
        <button className="btn small" disabled={busy}>{busy ? 'Saving…' : 'Record'}</button>
        <button type="button" className="btn btn-ghost small" onClick={cancel}>Cancel</button>
      </div>
    </form>
  );
}

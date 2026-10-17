import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { finance, type Acknowledgment, type AckCandidate, type AckRequest } from '../../../lib/finance';
import { DataTable } from '../ui/DataTable';
import { adminConfirm, adminToast } from '../ui/feedback';
import { ErrorNote, php } from './shared';

type Data = Awaited<ReturnType<typeof finance.acknowledgments>>;

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const shortDate = (d: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/**
 * Payment acknowledgment receipts — the document a facilitator signs to
 * confirm Hilom paid them. Pick a facilitator, tick the payments (offline
 * payments and paid payout batches), check the wording, preview, issue. The
 * PDF is numbered and stored; upload the signed copy when it comes back.
 */
export default function ReceiptsPage({ adminKey }: { adminKey: string }) {
  const [params, setParams] = useSearchParams();
  const facilitatorId = params.get('facilitator') ?? '';
  const preselect = params.get('pay');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    finance.acknowledgments(adminKey, facilitatorId || undefined).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey, facilitatorId]);
  useEffect(load, [load]);

  const facName = useMemo(() => new Map((data?.facilitators ?? []).map((f) => [f.id, f.display_name])), [data]);

  async function open(a: Acknowledgment, signed = false) {
    try {
      window.open((await finance.acknowledgmentPdf(adminKey, a.id, signed)).url, '_blank', 'noopener');
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not open');
    }
  }

  async function attachSigned(a: Acknowledgment) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const up = await finance.uploadReceipt(adminKey, file);
        await finance.attachSignedAcknowledgment(adminKey, a.id, up.key, file.name);
        adminToast.success(`Signed copy of ${a.receipt_no} saved`);
        load();
      } catch (e) {
        adminToast.error(e instanceof Error ? e.message : 'Upload failed');
      }
    };
    input.click();
  }

  async function voidIt(a: Acknowledgment) {
    const reason = window.prompt(`Void ${a.receipt_no}? Its payments can then go on a new receipt.\nReason:`);
    if (!reason) return;
    try {
      await finance.voidAcknowledgment(adminKey, a.id, reason);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not void');
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Payment acknowledgment receipts</h2>
          <p className="small muted">The receipt a facilitator signs to confirm Hilom paid them. Not a BIR invoice.</p>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      <div className="dash-card" style={{ marginBottom: '1rem' }}>
        <h3>New receipt</h3>
        <div className="fin-toolbar">
          <label>
            Facilitator
            <select
              value={facilitatorId}
              onChange={(e) => {
                const next = new URLSearchParams();
                if (e.target.value) next.set('facilitator', e.target.value);
                setParams(next, { replace: true });
              }}
            >
              <option value="">Choose…</option>
              {data?.facilitators.map((f) => <option key={f.id} value={f.id}>{f.display_name}</option>)}
            </select>
          </label>
        </div>
        {facilitatorId && data?.defaults && (
          <ReceiptForm
            key={facilitatorId}
            adminKey={adminKey}
            facilitatorId={facilitatorId}
            candidates={data.candidates}
            defaults={data.defaults}
            preselect={preselect}
            onIssued={load}
          />
        )}
      </div>

      <DataTable<Acknowledgment>
        id="finance-receipts"
        rows={data?.acknowledgments ?? null}
        loading={!data && !error}
        rowKey={(a) => a.id}
        columns={[
          { key: 'no', header: 'Receipt', pinned: true, sortValue: (a) => a.receipt_no, csv: (a) => a.receipt_no, render: (a) => <span className="fin-mono">{a.receipt_no}</span> },
          { key: 'date', header: 'Date', sortValue: (a) => a.issue_date, csv: (a) => a.issue_date },
          { key: 'to', header: 'Recipient', sortValue: (a) => a.data.recipient_name, csv: (a) => a.data.recipient_name, render: (a) => <div>{a.data.recipient_heading}<div className="small muted">{a.facilitator_id ? facName.get(a.facilitator_id) : ''} · {a.data.lines.length} payment(s)</div></div> },
          { key: 'total', header: 'Total', align: 'right', sortValue: (a) => a.total_centavos, csv: (a) => a.total_centavos / 100, render: (a) => <span className="fin-num">{php(a.total_centavos)}</span> },
          {
            key: 'status',
            header: 'Status',
            sortValue: (a) => a.status,
            csv: (a) => a.status,
            render: (a) => (
              <span className={a.status === 'signed' ? 'pill pill-ok' : a.status === 'void' ? 'pill' : 'pill pill-warn'} title={a.void_reason ?? undefined}>
                {a.status === 'issued' ? 'awaiting signature' : a.status}
              </span>
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (a) => (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost small" onClick={() => open(a)}>PDF</button>
                {a.signed_key && <button type="button" className="btn btn-ghost small" onClick={() => open(a, true)}>Signed copy</button>}
                {a.status !== 'void' && <button type="button" className="btn btn-ghost small" onClick={() => attachSigned(a)}>{a.signed_key ? 'Replace signed' : 'Upload signed'}</button>}
                {a.status !== 'void' && <button type="button" className="btn btn-ghost small" onClick={() => voidIt(a)}>Void</button>}
              </span>
            ),
          },
        ]}
        defaultSort={{ key: 'no', dir: 'desc' }}
        csvName="hilom-payment-receipts"
        searchText={(a) => `${a.receipt_no} ${a.data.recipient_heading} ${a.data.subtitle}`}
        empty={{ title: 'No receipts issued yet', body: 'Choose a facilitator above to issue the first one.' }}
      />
    </div>
  );
}

function ReceiptForm({
  adminKey,
  facilitatorId,
  candidates,
  defaults,
  preselect,
  onIssued,
}: {
  adminKey: string;
  facilitatorId: string;
  candidates: AckCandidate[];
  defaults: NonNullable<Data['defaults']>;
  preselect: string | null;
  onIssued: () => void;
}) {
  const open = candidates.filter((c) => !c.receipt_no);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preselect ? [preselect] : open.map((c) => c.id)));
  const [f, setF] = useState({ ...defaults, issue_date: today() });
  const [layout, setLayout] = useState<'auto' | 'dated' | 'described'>('auto');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [withSignature, setWithSignature] = useState(true);
  const [busy, setBusy] = useState(false);

  const chosen = candidates.filter((c) => picked.has(c.id));
  const effectiveLayout = layout === 'auto' ? (chosen.length > 1 ? 'dated' : 'described') : layout;
  const total = chosen.reduce((s, c) => s + c.amount_centavos, 0);

  const body = (): AckRequest => ({
    facilitator_id: facilitatorId,
    payment_ids: [...picked],
    issue_date: f.issue_date,
    recipient_heading: f.recipient_heading,
    recipient_name: f.recipient_name,
    recipient_title: f.recipient_title,
    subtitle: f.subtitle,
    layout: effectiveLayout,
    include_signature: withSignature,
    labels: Object.fromEntries(Object.entries(labels).filter(([id, v]) => picked.has(id) && v.trim())),
  });

  async function preview() {
    setBusy(true);
    try {
      const { pdf_base64 } = await finance.previewAcknowledgment(adminKey, body());
      const bytes = Uint8Array.from(atob(pdf_base64), (c) => c.charCodeAt(0));
      window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    const ok = await adminConfirm({
      title: `Issue a receipt for ${php(total)}?`,
      body: `To ${f.recipient_heading}, ${chosen.length} payment(s). It gets the next HC-AR number and is kept on record; void it if it's wrong.`,
      confirmLabel: 'Issue receipt',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { acknowledgment } = await finance.issueAcknowledgment(adminKey, body());
      adminToast.success(`${acknowledgment.receipt_no} issued`);
      const { url } = await finance.acknowledgmentPdf(adminKey, acknowledgment.id);
      window.open(url, '_blank', 'noopener');
      setPicked(new Set());
      onIssued();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not issue');
    } finally {
      setBusy(false);
    }
  }

  if (!candidates.length) {
    return (
      <p className="small muted">
        No recorded payments to this facilitator yet. Record one under Offline transactions (Payment to facilitator), or mark a payout batch paid.
      </p>
    );
  }

  return (
    <div>
      <table className="pnl" style={{ marginBottom: '1rem' }}>
        <thead>
          <tr><th style={{ width: 30 }} /><th>Paid</th><th>Payment</th><th>Line on the receipt</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.id} className={c.receipt_no ? 'row-muted' : ''}>
              <td>
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  disabled={!!c.receipt_no}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                />
              </td>
              <td>{c.date}</td>
              <td>
                {c.description}
                <div className="small muted">{c.kind === 'payout' ? 'Payout batch' : 'Offline payment'}{c.receipt_no ? ` · on ${c.receipt_no}` : ''}</div>
              </td>
              <td>
                {picked.has(c.id) && (
                  <input
                    style={{ width: '100%', font: 'inherit', padding: '0.25rem 0.4rem', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)', color: 'var(--ink)' }}
                    value={labels[c.id] ?? (effectiveLayout === 'dated' ? shortDate(c.date) : c.description)}
                    onChange={(e) => setLabels({ ...labels, [c.id]: e.target.value })}
                  />
                )}
              </td>
              <td className="n">{php(c.amount_centavos)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="fin-form">
        <label>Recipient (header)<input value={f.recipient_heading} onChange={(e) => setF({ ...f, recipient_heading: e.target.value })} placeholder="PREMYER TAMAYO (PREM)" /></label>
        <label>Recipient full name<input value={f.recipient_name} onChange={(e) => setF({ ...f, recipient_name: e.target.value })} placeholder="Premyer Tamayo" /></label>
        <label>Recipient role<input value={f.recipient_title} onChange={(e) => setF({ ...f, recipient_title: e.target.value })} /></label>
        <label>Receipt date<input type="date" value={f.issue_date} onChange={(e) => setF({ ...f, issue_date: e.target.value })} /></label>
        <label className="wide">For (line under the name)<input value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} placeholder="HIIT Pilates Group Class and Teacher Training" /></label>
        <label>
          Table
          <select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
            <option value="auto">Automatic ({effectiveLayout === 'dated' ? 'by payment date' : 'by description'})</option>
            <option value="dated">Payment Date | Amount</option>
            <option value="described">Description | Amount</option>
          </select>
        </label>
        <label><span><input type="checkbox" checked={withSignature} onChange={(e) => setWithSignature(e.target.checked)} /> Include the CEO’s signature</span></label>
      </div>
      <div className="fin-form-actions">
        <b className="fin-num">{chosen.length} payment(s) · {php(total)}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost small" disabled={busy || !chosen.length || !f.recipient_name} onClick={preview}>Preview PDF</button>
        <button type="button" className="btn small" disabled={busy || !chosen.length || !f.recipient_name || !f.recipient_heading} onClick={issue}>Issue receipt</button>
      </div>
    </div>
  );
}

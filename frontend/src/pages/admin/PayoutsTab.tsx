/**
 * Admin → Payouts.
 *
 * Hilom collects every payment and transfers each facilitator's share by hand.
 * This screen is the ledger that makes that defensible: it builds a batch from
 * the delivered, not-yet-paid sessions in a period, shows the arithmetic, and
 * records the reference once the money has actually moved.
 *
 * The batch has three states for a reason. `draft` is "these are the numbers",
 * `approved` is "checked, go and send it", `paid` is "money has left the
 * account, here is the reference". Collapsing them would mean the only record
 * of a transfer being authorised is that it already happened.
 *
 * Nothing here moves money. When split payments arrive (PayMongo Platforms,
 * Xendit), a payout row stops being an instruction and becomes a record of what
 * the processor settled — the per-booking fee split on each booking is already
 * shaped for that.
 */
import { useCallback, useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import {
  adminBuildPayout,
  adminListFacilitators,
  adminListPayouts,
  adminUpdatePayout,
  adminListClassRegistrations,
  adminMarkClassRefundSent,
  type AdminFacilitator,
  type AdminPayout,
  type AdminClassRegistration,
} from '../../lib/booking';
import { adminConfirm, adminToast } from './ui/feedback';
import { downloadCsv } from './ui/DataTable';
import { BarList } from './ui/Charts';

const flatDetails = (d: Record<string, unknown> | undefined) =>
  d ? Object.entries(d).map(([k, v]) => `${k}: ${String(v ?? '')}`).join('; ') : '';

/** A printable statement of every batch for one facilitator. */
function printStatement(name: string, rows: AdminPayout[]) {
  const w = window.open('', '_blank', 'width=720,height=800');
  if (!w) return;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const d = (iso: string) => new Date(iso).toLocaleDateString('en-PH', { dateStyle: 'medium' });
  const live = rows.filter((r) => r.status !== 'void');
  const paid = live.filter((r) => r.status === 'paid').reduce((a, r) => a + r.net_centavos, 0);
  const due = live.filter((r) => r.status !== 'paid').reduce((a, r) => a + r.net_centavos, 0);
  w.document.write(`<!doctype html><html><head><title>Statement — ${esc(name)}</title>
<style>body{font-family:Arial,sans-serif;color:#2b332c;max-width:680px;margin:32px auto;padding:0 16px}
h1{font-family:Georgia,serif;color:#2f5e3e;font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:20px 0;font-size:13px}
th,td{padding:6px 4px;border-bottom:1px solid #e7e0cc;text-align:left}td.n,th.n{text-align:right}.muted{color:#6b7568;font-size:13px}</style></head><body>
<h1>Hilom Collective — Payout statement</h1><div class="muted">${esc(name)} · generated ${esc(new Date().toLocaleDateString('en-PH', { dateStyle: 'long' }))}</div>
<table><tr><th>Period</th><th class="n">Gross</th><th class="n">Hilom fee</th><th class="n">Processing</th><th class="n">Net</th><th>Status</th><th>Reference</th></tr>
${live.map((r) => `<tr><td>${d(r.period_start)} – ${d(r.period_end)}</td><td class="n">${esc(money(r.gross_centavos))}</td><td class="n">${esc(money(r.platform_fee_centavos))}</td><td class="n">${esc(money(r.processing_fee_centavos))}</td><td class="n"><b>${esc(money(r.net_centavos))}</b></td><td>${r.status}</td><td>${esc(r.reference ?? '')}</td></tr>`).join('')}
</table><p><b>Paid to date:</b> ${esc(money(paid))} &nbsp; · &nbsp; <b>Outstanding:</b> ${esc(money(due))}</p>
<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

/** First and last instant of the calendar month `offset` months back. */
function monthRange(offset: number): { start: string; end: string; label: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(start),
  };
}

export default function PayoutsTab({ adminKey }: { adminKey: string }) {
  const [payouts, setPayouts] = useState<AdminPayout[] | null>(null);
  const [facilitators, setFacilitators] = useState<AdminFacilitator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [facilitatorId, setFacilitatorId] = useState('');
  const [monthOffset, setMonthOffset] = useState(1);
  const [processingFeePesos, setProcessingFeePesos] = useState('');

  const reload = useCallback(() => {
    adminListPayouts(adminKey)
      .then(setPayouts)
      .catch((err: Error) => setError(err.message));
  }, [adminKey]);

  useEffect(() => {
    reload();
    // Only published and approved facilitators can have delivered sessions.
    adminListFacilitators(adminKey)
      .then((rows) => setFacilitators(rows.filter((f) => f.status === 'published' || f.status === 'approved')))
      .catch((err: Error) => setError(err.message));
  }, [adminKey, reload]);

  const period = monthRange(monthOffset);

  async function build() {
    if (!facilitatorId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminBuildPayout(adminKey, {
        facilitator_id: facilitatorId,
        period_start: period.start,
        period_end: period.end,
        processing_fee_centavos: Math.round(Number(processingFeePesos || 0) * 100),
      });
      setNotice(`Batch created from ${result.sessionCount} session(s)`);
      setProcessingFeePesos('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build batch');
    } finally {
      setBusy(false);
    }
  }

  async function update(payout: AdminPayout, patch: Record<string, unknown>) {
    setError(null);
    try {
      await adminUpdatePayout(adminKey, payout.id, patch);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    }
  }

  async function markPaid(payout: AdminPayout) {
    const reference = window.prompt(
      `Mark ${money(payout.net_centavos)} to ${payout.facilitators?.display_name ?? 'this facilitator'} as paid.\n\nBank transfer reference:`,
      payout.reference ?? '',
    );
    if (reference === null) return;
    await update(payout, { status: 'paid', reference });
    adminToast.success(`Marked ${money(payout.net_centavos)} paid`);
  }

  return (
    <>
      <h2>Payouts</h2>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {/* Above the batch builder on purpose: a refund somebody is waiting on
          is more urgent than this month's payout run, and renders nothing at
          all when none is owed. */}
      <ClassRefundsPanel adminKey={adminKey} onError={setError} onDone={setNotice} />

      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>New batch</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Pulls every delivered session in the period that isn't already in a batch.
        </p>

        <div className="two-col">
          <label className="field">
            <span>Facilitator</span>
            <select value={facilitatorId} onChange={(e) => setFacilitatorId(e.target.value)}>
              <option value="">Choose…</option>
              {facilitators.map((f) => (
                <option key={f.id} value={f.id}>{f.display_name}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Period</span>
            <select value={monthOffset} onChange={(e) => setMonthOffset(Number(e.target.value))}>
              {[0, 1, 2, 3].map((offset) => (
                <option key={offset} value={offset}>{monthRange(offset).label}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>Payment processing cost for this batch (₱)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={processingFeePesos}
            onChange={(e) => setProcessingFeePesos(e.target.value)}
          />
          {/* Entered by hand because PayMongo's per-transaction fee is not on
              the webhook payload — deriving it here would be guesswork. */}
          <small className="muted">
            PayMongo's cost isn't in the webhook data, so enter it from the dashboard. Deducted from
            the facilitator's net.
          </small>
        </label>

        <button
          type="button"
          className="btn btn-accent"
          disabled={busy || !facilitatorId}
          onClick={() => void build()}
        >
          {busy ? 'Building…' : 'Build batch'}
        </button>
      </div>

      {payouts && payouts.length > 0 && <PayoutSummary payouts={payouts} onMarkPaid={markPaid} />}

      <h3>Batches</h3>
      {payouts === null && <div className="spinner" aria-label="Loading" />}
      {payouts !== null && payouts.length === 0 && <p className="muted">No payouts yet.</p>}

      {(payouts ?? []).map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: '0.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{p.facilitators?.display_name ?? 'Unknown'}</strong>
            <span className={`pill ${p.status === 'paid' ? 'pill-ok' : p.status === 'void' ? 'pill-bad' : 'pill-warn'}`}>
              {p.status}
            </span>
          </div>

          <p className="small muted" style={{ margin: '0.25rem 0 0.5rem' }}>
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(p.period_start))} –{' '}
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(p.period_end))}
          </p>

          {/* The full arithmetic, not just the total — this is the number a
              facilitator will ask about, and it should be answerable here. */}
          <p className="small mono" style={{ margin: '0 0 0.5rem' }}>
            gross {money(p.gross_centavos)} − Hilom {money(p.platform_fee_centavos)} − processing{' '}
            {money(p.processing_fee_centavos)} = <strong>{money(p.net_centavos)}</strong>
          </p>

          {p.facilitators?.payout_details && Object.keys(p.facilitators.payout_details).length > 0 && (
            <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
              Pay to: {String(p.facilitators.payout_details.bank ?? '—')}{' '}
              {String(p.facilitators.payout_details.account ?? '')}
            </p>
          )}

          {p.reference && <p className="small muted">Ref: {p.reference}</p>}

          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {p.status === 'draft' && (
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => void update(p, { status: 'approved' })}
              >
                Approve
              </button>
            )}
            {p.status === 'approved' && (
              <button type="button" className="btn btn-accent small" onClick={() => void markPaid(p)}>
                Mark paid
              </button>
            )}
            {p.status !== 'paid' && p.status !== 'void' && (
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={async () => {
                  if (
                    await adminConfirm({
                      title: 'Void this batch?',
                      body: 'Its sessions go back into the unpaid pool so the batch can be rebuilt.',
                      confirmLabel: 'Void batch',
                      danger: true,
                    })
                  )
                    void update(p, { status: 'void' });
                }}
              >
                Void
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Class refunds owed (0051).
 *
 * Cancelling a group class date releases everyone's seat and records what each
 * person is owed, but moves no money — refunds here are issued by hand, like
 * every other refund on the platform. This is the queue that makes that
 * defensible.
 *
 * It sits above the payout batches rather than in its own tab because both are
 * the same job: money Hilom has to move by hand, in a list, with a reference
 * recorded once it has gone. An admin doing one is doing the other.
 *
 * It renders nothing when the queue is empty. A permanently visible "0 owed"
 * panel is a thing people stop reading, and this one needs to be noticed on
 * the day it is not zero — the help centre tells clients to chase us after a
 * week.
 */
function ClassRefundsPanel({
  adminKey,
  onError,
  onDone,
}: {
  adminKey: string;
  onError: (message: string | null) => void;
  onDone: (message: string) => void;
}) {
  const [rows, setRows] = useState<AdminClassRegistration[]>([]);
  const [owedTotal, setOwedTotal] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    adminListClassRegistrations(adminKey, true)
      .then((r) => {
        setRows(r.registrations);
        setOwedTotal(r.owedTotalCentavos);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setLoaded(true));
  }, [adminKey, onError]);

  useEffect(reload, [reload]);

  async function markSent(row: AdminClassRegistration) {
    const reference = window.prompt(
      `Bank or PayMongo reference for the ${money(row.refund_centavos ?? 0, row.currency)} refund to ${row.client_email}?`,
    );
    if (reference === null) return;
    if (!reference.trim()) {
      onError('A reference is required — without one the refund cannot be reconciled later.');
      return;
    }

    setBusyId(row.id);
    onError(null);
    try {
      await adminMarkClassRefundSent(adminKey, row.id, reference.trim());
      reload();
      onDone(`Refund to ${row.client_email} recorded as sent.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded || rows.length === 0) return null;

  return (
    <div className="panel" style={{ borderLeft: '3px solid var(--ochre-dark)' }}>
      <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>
        Class refunds owed — {money(owedTotal)}
      </h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Group classes that were cancelled after someone paid. Nothing here has been refunded
        yet. The help centre tells people to allow a few working days and to chase us after a
        week, so the oldest are listed first.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Class</th>
              <th>Cancelled</th>
              <th style={{ textAlign: 'right' }}>Owed</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const waitingDays = row.cancelled_at
                ? Math.floor((Date.now() - Date.parse(row.cancelled_at)) / 86_400_000)
                : 0;
              return (
                <tr key={row.id}>
                  <td className="small">
                    <strong>{row.client_name || row.client_email}</strong>
                    {row.client_name && <div className="muted">{row.client_email}</div>}
                  </td>
                  <td className="small">
                    {row.facilitator_class_sessions?.facilitator_classes?.title ?? 'Class'}
                    <div className="muted">{row.facilitators?.display_name}</div>
                  </td>
                  <td className="small">
                    {row.cancelled_at
                      ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(
                          new Date(row.cancelled_at),
                        )
                      : '—'}
                    {/* Past the window the help centre told them to expect. */}
                    {waitingDays >= 7 && (
                      <div>
                        <span className="pill pill-bad" style={{ fontSize: '0.7rem' }}>
                          {waitingDays} days
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="small" style={{ textAlign: 'right' }}>
                    {money(row.refund_centavos ?? 0, row.currency)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn-primary small"
                      disabled={busyId === row.id}
                      onClick={() => void markSent(row)}
                      title="Record that this refund has been sent"
                    >
                      {busyId === row.id ? '…' : 'Mark refunded'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What is owed, by whom, and the two exports a payout run needs: a bank CSV of
 * everything approved (with the facilitator's payout details flattened in) and
 * a printable statement per facilitator.
 */
function PayoutSummary({ payouts, onMarkPaid }: { payouts: AdminPayout[]; onMarkPaid: (p: AdminPayout) => Promise<void> }) {
  const approved = payouts.filter((p) => p.status === 'approved');
  const drafts = payouts.filter((p) => p.status === 'draft');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const paidThisMonth = payouts
    .filter((p) => p.status === 'paid' && p.paid_at && new Date(p.paid_at).getTime() >= monthStart)
    .reduce((a, p) => a + p.net_centavos, 0);
  const owedBy = new Map<string, { name: string; value: number; rows: AdminPayout[] }>();
  for (const p of payouts) {
    const k = p.facilitator_id;
    const cur = owedBy.get(k) ?? { name: p.facilitators?.display_name ?? 'Unknown', value: 0, rows: [] };
    cur.rows.push(p);
    if (p.status === 'approved' || p.status === 'draft') cur.value += p.net_centavos;
    owedBy.set(k, cur);
  }
  const owed = [...owedBy.values()].filter((o) => o.value > 0).sort((a, b) => b.value - a.value);
  const sum = (rows: AdminPayout[]) => rows.reduce((a, p) => a + p.net_centavos, 0);

  return (
    <div className="panel" style={{ margin: '1.25rem 0' }}>
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat stat--attention">
          <span className="stat__label">Approved, to send</span>
          <span className="stat__value">{money(sum(approved))}</span>
          <span className="stat__hint">{approved.length} batch{approved.length === 1 ? '' : 'es'}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Drafts to check</span>
          <span className="stat__value">{money(sum(drafts))}</span>
          <span className="stat__hint">{drafts.length} batch{drafts.length === 1 ? '' : 'es'}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Paid this month</span>
          <span className="stat__value">{money(paidThisMonth)}</span>
        </div>
      </div>

      {owed.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Owed by facilitator</h3>
          <BarList items={owed.map((o) => ({ label: o.name, value: o.value }))} format={(v) => money(v)} />
        </>
      )}

      <div className="row" style={{ marginTop: '1rem' }}>
        <button
          type="button"
          className="btn btn-ghost small"
          disabled={!approved.length}
          onClick={() =>
            downloadCsv(
              'payouts-bank',
              ['facilitator', 'email', 'amount_php', 'period_start', 'period_end', 'payout_details', 'batch_id'],
              approved.map((p) => [
                p.facilitators?.display_name ?? '',
                p.facilitators?.email ?? '',
                (p.net_centavos / 100).toFixed(2),
                p.period_start.slice(0, 10),
                p.period_end.slice(0, 10),
                flatDetails(p.facilitators?.payout_details),
                p.id,
              ]),
            )
          }
        >
          Bank CSV ({approved.length} approved)
        </button>
        <button
          type="button"
          className="btn btn-accent small"
          disabled={!approved.length}
          onClick={async () => {
            for (const p of approved) await onMarkPaid(p);
          }}
          title="Asks for each transfer reference in turn"
        >
          Mark approved batches paid…
        </button>
        <select
          aria-label="Print a statement"
          value=""
          onChange={(e) => {
            const o = owedBy.get(e.target.value);
            if (o) printStatement(o.name, o.rows);
          }}
          style={{ width: 'auto', padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
        >
          <option value="">Print statement for…</option>
          {[...owedBy.entries()].map(([id, o]) => (
            <option key={id} value={id}>{o.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

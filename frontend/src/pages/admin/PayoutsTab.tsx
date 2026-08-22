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
  type AdminFacilitator,
  type AdminPayout,
} from '../../lib/booking';

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
  }

  return (
    <>
      <h2>Payouts</h2>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

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
                onClick={() => {
                  if (
                    window.confirm(
                      'Void this batch?\n\nIts sessions go back into the unpaid pool so the batch can be rebuilt.',
                    )
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

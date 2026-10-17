import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { finance, type ApplyResult, type SplitRule, type SplitRulesResponse } from '../../../lib/finance';
import { adminConfirm, adminToast } from '../ui/feedback';
import { ErrorNote, php } from './shared';

const describe = (r: Pick<SplitRule, 'kind' | 'bps' | 'flat_facilitator_centavos' | 'fee_borne_by'>) =>
  r.kind === 'percent_fee'
    ? `Hilom keeps ${(r.bps ?? 0) / 100}%`
    : r.kind === 'flat_per_seat'
      ? `Facilitator gets ${php(r.flat_facilitator_centavos ?? 0)} per seat, Hilom keeps the rest`
      : 'Hilom keeps 100% — no facilitator share';

/**
 * Deals that are not the facilitator's standard percentage — Batara's flat
 * ₱1,500 a head, a Hilom-owned programme a facilitator hosts, a one-off rate
 * for one event. The webhook applies the rule to every new paid charge;
 * "Apply to unpaid charges" re-splits ones already paid but not yet batched.
 */
export default function SplitRulesPage({ adminKey }: { adminKey: string }) {
  const [data, setData] = useState<SplitRulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rule: SplitRule; result: ApplyResult } | null>(null);

  const load = useCallback(() => {
    setError(null);
    finance.splitRules(adminKey).then(setData).catch((e: Error) => setError(e.message));
  }, [adminKey]);
  useEffect(load, [load]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of data?.events ?? []) m.set(e.id, `${e.title}${e.starts_at ? ` (${e.starts_at.slice(0, 10)})` : ''}`);
    for (const s of data?.series ?? []) m.set(s.id, `Series: ${s.title}`);
    for (const f of data?.facilitators ?? []) m.set(f.id, `All events by ${f.display_name}`);
    return m;
  }, [data]);

  const live = data?.rules.filter((r) => !r.voided_at) ?? [];
  const history = data?.rules.filter((r) => r.voided_at) ?? [];

  async function showPreview(rule: SplitRule) {
    try {
      setPreview({ rule, result: await finance.previewSplitRule(adminKey, rule.id) });
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Preview failed');
    }
  }

  async function apply() {
    if (!preview) return;
    const ok = await adminConfirm({
      title: 'Re-split these charges?',
      body: `${preview.result.changes.length} paid charge(s) not yet in a payout will be re-split. Facilitator payable changes by ${php(preview.result.facilitator_delta_centavos)}. Charges already batched or paid keep their split.`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    try {
      const r = await finance.applySplitRule(adminKey, preview.rule.id);
      adminToast.success(`${r.applied} charge(s) re-split`);
      setPreview(null);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Apply failed');
    }
  }

  async function voidRule(r: SplitRule) {
    if (!(await adminConfirm({ title: 'Remove this rule?', body: 'New payments fall back to the event’s own rate. Charges already split keep their split.', danger: true, confirmLabel: 'Remove' }))) return;
    try {
      await finance.voidSplitRule(adminKey, r.id);
      load();
    } catch (e) {
      adminToast.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  const eventsNoSplit = (data?.events ?? []).filter(
    (e) => e.platform_fee_bps === null && !live.some((r) => r.scope_id === e.id || r.scope_id === e.series_id || r.scope_id === e.facilitator_id),
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Revenue splits</h2>
          <p className="small muted">
            Order of precedence: event rule → series rule → facilitator rule → the event’s own rate. Without any, a facilitator’s event is treated as Hilom’s and nothing is payable.
          </p>
        </div>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}

      {data && <RuleForm adminKey={adminKey} data={data} onSaved={load} />}

      {eventsNoSplit.length > 0 && (
        <div className="alert alert-warning">
          {eventsNoSplit.length} facilitator event(s) have no split at all: {eventsNoSplit.slice(0, 5).map((e) => e.title).join(', ')}
          {eventsNoSplit.length > 5 ? '…' : ''}
        </div>
      )}

      <div className="dash-card">
        <h3>Active rules</h3>
        {live.length === 0 && <p className="small muted">None yet — every event uses its own rate.</p>}
        {live.map((r) => (
          <div className="fin-exc" key={r.id}>
            <span className="pill">{r.scope.replace('_', ' ')}</span>
            <div className="fin-exc__body">
              <div className="fin-exc__title">{names.get(r.scope_id) ?? r.scope_id}</div>
              <div className="small muted">
                {describe(r)} · PayMongo fee borne by {r.fee_borne_by}
                {r.note ? ` · ${r.note}` : ''} · set by {r.created_by} {new Date(r.created_at).toLocaleDateString('en-PH')}
              </div>
            </div>
            <div className="fin-exc__actions">
              <button type="button" className="btn btn-ghost small" onClick={() => showPreview(r)}>Apply to unpaid charges…</button>
              <button type="button" className="btn btn-ghost small" onClick={() => voidRule(r)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <div className="dash-card" style={{ marginTop: '1rem' }}>
          <h3>Preview — {names.get(preview.rule.scope_id)}</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            {preview.result.changes.length} charge(s) would change; {preview.result.skipped_batched} already in a payout are left alone. Facilitator payable {preview.result.facilitator_delta_centavos >= 0 ? 'rises' : 'falls'} by {php(Math.abs(preview.result.facilitator_delta_centavos))}.
          </p>
          {preview.result.changes.length > 0 && (
            <table className="pnl">
              <thead>
                <tr><th>Charge</th><th>Hilom now</th><th>Hilom after</th><th>Facilitator now</th><th>Facilitator after</th></tr>
              </thead>
              <tbody>
                {preview.result.changes.slice(0, 50).map((c) => (
                  <tr key={c.charge_id}>
                    <td className="fin-mono">{c.charge_id.slice(0, 8)}</td>
                    <td className="n">{c.from.fee === null ? 'all (no split)' : php(c.from.fee)}</td>
                    <td className="n">{c.to.fee === null ? 'all (no split)' : php(c.to.fee)}</td>
                    <td className="n">{php(c.from.net ?? 0)}</td>
                    <td className="n"><b>{php(c.to.net ?? 0)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="fin-form-actions">
            <button type="button" className="btn small" disabled={!preview.result.changes.length} onClick={apply}>Apply</button>
            <button type="button" className="btn btn-ghost small" onClick={() => setPreview(null)}>Close</button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary className="small muted">Replaced and removed rules ({history.length})</summary>
          {history.map((r) => (
            <div key={r.id} className="small muted" style={{ padding: '0.3rem 0' }}>
              {names.get(r.scope_id) ?? r.scope_id}: {describe(r)} — {new Date(r.created_at).toLocaleDateString('en-PH')} to {new Date(r.voided_at!).toLocaleDateString('en-PH')}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function RuleForm({ adminKey, data, onSaved }: { adminKey: string; data: SplitRulesResponse; onSaved: () => void }) {
  const [scope, setScope] = useState<SplitRule['scope']>('event');
  const [scopeId, setScopeId] = useState('');
  const [kind, setKind] = useState<SplitRule['kind']>('flat_per_seat');
  const [value, setValue] = useState('');
  const [feeBy, setFeeBy] = useState<SplitRule['fee_borne_by']>('hilom');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const options =
    scope === 'event'
      ? data.events.map((e) => ({ id: e.id, label: `${e.title}${e.starts_at ? ` (${e.starts_at.slice(0, 10)})` : ''}` }))
      : scope === 'event_series'
        ? data.series.map((s) => ({ id: s.id, label: s.title }))
        : data.facilitators.map((f) => ({ id: f.id, label: f.display_name }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await finance.createSplitRule(adminKey, {
        scope,
        scope_id: scopeId,
        kind,
        bps: kind === 'percent_fee' ? Math.round(Number(value) * 100) : null,
        flat_facilitator_centavos: kind === 'flat_per_seat' ? Math.round(Number(value) * 100) : null,
        fee_borne_by: feeBy,
        note: note || null,
      });
      adminToast.success('Rule saved — new payments use it. Apply it to already-paid charges from the list.');
      setValue('');
      setNote('');
      onSaved();
    } catch (err) {
      adminToast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dash-card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <h3>New rule</h3>
      <div className="fin-form">
        <label>
          Applies to
          <select value={scope} onChange={(e) => { setScope(e.target.value as SplitRule['scope']); setScopeId(''); }}>
            <option value="event">One event</option>
            <option value="event_series">An event series</option>
            <option value="facilitator">All of a facilitator’s events</option>
          </select>
        </label>
        <label>
          Which
          <select required value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label>
          Deal
          <select value={kind} onChange={(e) => setKind(e.target.value as SplitRule['kind'])}>
            <option value="flat_per_seat">Flat ₱ per seat to facilitator</option>
            <option value="percent_fee">Hilom keeps a %</option>
            <option value="hilom_owned">Hilom-owned (no facilitator share)</option>
          </select>
        </label>
        {kind !== 'hilom_owned' && (
          <label>
            {kind === 'flat_per_seat' ? 'Facilitator gets (₱ per seat)' : 'Hilom keeps (%)'}
            <input type="number" min="0" step="0.01" max={kind === 'percent_fee' ? 100 : undefined} required value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        <label>
          PayMongo fee borne by
          <select value={feeBy} onChange={(e) => setFeeBy(e.target.value as SplitRule['fee_borne_by'])}>
            <option value="hilom">Hilom</option>
            <option value="facilitator">Facilitator (deduct as processing fee on payout)</option>
          </select>
        </label>
        <label className="wide">Note (what was agreed, where)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Agreed with Batara by email, Sep 10" /></label>
      </div>
      <div className="fin-form-actions">
        <button className="btn small" disabled={busy || !scopeId}>Save rule</button>
      </div>
    </form>
  );
}

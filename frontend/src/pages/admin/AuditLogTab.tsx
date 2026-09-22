/**
 * Admin → Audit Log: every sensitive action, in one reverse-chronological
 * table.
 *
 * `admin_audit_log` has recorded event-registration money actions (refunds,
 * cancellations, price overrides, waived charges) and event decisions since
 * 0017. Booking and class refunds, payouts, facilitator decisions and course
 * order/product changes were not audited at all until 23 Sep 2026, so older
 * actions of those kinds are absent, and the subtitle says so. `GET
 * /admin/audit-log` has existed the whole time, and until this screen
 * the only place any of it was visible was a fragment at the bottom of a
 * single registration. "Who unpublished that event, and when?" had an exact
 * answer sitting in a table with no door. See
 * docs/admin-dashboard-plan.md §3.
 *
 * **Why the actor column needs care.** `actor_source` is load-bearing. A
 * `shared_key` actor label is a name somebody typed into a box — an
 * attestation, not an identity — because every admin surface here still
 * authorizes with one shared key (lib/audit.ts). A `cognito` label is a
 * verified email. Rendering both as plain text would invite an operator to
 * treat a self-declared name as proof, which is exactly the misreading the
 * column exists to prevent — so the source is a badge beside the name, and
 * the line above the table says what the badge means before anyone reads a
 * row.
 */
import { useCallback, useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import { adminListAuditLog, type AuditEntry } from '../../lib/cms';

/** Every `action` value this codebase currently writes, for the filter. An
 *  unrecognised value typed into the box still works — the filter is sent to
 *  the backend as-is — this list only saves an operator from guessing the
 *  exact spelling. */
const KNOWN_ACTIONS = [
  'booking.cancel',
  'booking.refund_sent',
  'charge.mark_paid_offline',
  'charge.waive',
  'charge.void',
  'class_registration.refund_sent',
  'event.approved',
  'event.rejected',
  'event.status_changed',
  'event.ticketing_updated',
  'event.join_details_sent',
  'event.roster_exported',
  'facilitator.status_changed',
  'order.retry_enrollment',
  'order.revoked',
  'payout.created',
  'payout.approved',
  'payout.paid',
  'payout.void',
  'payout.updated',
  'people.exported',
  'plan.replaced',
  'product.price_changed',
  'product.visibility_changed',
  'registration.cancel',
  'registration.cancellation_declined',
  'registration.nudged',
  'registration.price_override',
  'registration.refund_sent',
  'registration.registrant_updated',
  'registration.transferred',
];

const manilaDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/** Today in Manila as yyyy-mm-dd, which is what a date input reads and writes. */
const manilaToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

/**
 * A picked calendar day, as the UTC instant its Manila day starts or ends.
 *
 * The table shows Manila time, so the picker must mean Manila days. Sending
 * the bare date would be read as UTC midnight — eight hours late — and a pick
 * of "Sep 21" would drop that morning's entries and include the next one's.
 * Manila has no daylight saving, so a fixed +08:00 is exact.
 */
const manilaDayStart = (day: string) => new Date(`${day}T00:00:00.000+08:00`).toISOString();
const manilaDayEnd = (day: string) => new Date(`${day}T23:59:59.999+08:00`).toISOString();

/** The backend's cap. Always asked for, so the screen never silently shows its default 100. */
const ROW_LIMIT = 500;

export default function AuditLogTab({ adminKey }: { adminKey: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [action, setAction] = useState('');
  const [moneyOnly, setMoneyOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [targetId, setTargetId] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, string> = { limit: String(ROW_LIMIT) };
      if (action) params.action = action;
      if (moneyOnly) params.money = '1';
      if (from) params.from = manilaDayStart(from);
      if (to) params.to = manilaDayEnd(to);
      if (targetId.trim()) params.targetId = targetId.trim();
      setEntries(await adminListAuditLog(adminKey, params));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [adminKey, action, moneyOnly, from, to, targetId]);

  useEffect(() => void load(), [load]);

  const clearFilters = () => {
    setAction('');
    setMoneyOnly(false);
    setFrom('');
    setTo('');
    setTargetId('');
  };

  const filtersActive = Boolean(action || moneyOnly || from || to || targetId.trim());

  return (
    <div className="panel">
      <h2 style={{ fontSize: '1.15rem', marginTop: 0, marginBottom: '0.25rem' }}>Audit Log</h2>
      <p className="small muted" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
        Money and access decisions — refunds, cancellations, charge overrides, payouts, order
        revokes, price changes, and facilitator and event approvals — most recent first. Payouts,
        booking and class refunds, facilitator decisions and order/product changes were only
        recorded from 23 Sep 2026; earlier ones of those kinds are not here. Dates are Manila
        time. <ActorLegend />
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="Filter by action"
          style={{ maxWidth: 260 }}
        >
          <option value="">Every action</option>
          {KNOWN_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={moneyOnly} onChange={(e) => setMoneyOnly(e.target.checked)} />
          Money only
        </label>

        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          From
          <input
            type="date"
            value={from}
            max={to || manilaToday()}
            onChange={(e) => setFrom(e.target.value)}
            style={{ maxWidth: 150 }}
          />
        </label>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            max={manilaToday()}
            onChange={(e) => setTo(e.target.value)}
            style={{ maxWidth: 150 }}
          />
        </label>

        <input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="Target id (uuid)"
          style={{ maxWidth: 220 }}
        />

        {filtersActive && (
          <button type="button" className="btn btn-ghost small" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}
      {busy && !entries && <div className="spinner" aria-label="Loading" />}

      {entries && entries.length === 0 && (
        <p className="small muted">No matching entries.</p>
      )}

      {entries && entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--line)' }}>
                <th style={{ padding: '8px 10px' }}>When</th>
                <th style={{ padding: '8px 10px' }}>Actor</th>
                <th style={{ padding: '8px 10px' }}>Action</th>
                <th style={{ padding: '8px 10px' }}>Target</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Amount</th>
                <th style={{ padding: '8px 10px' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entries && entries.length >= ROW_LIMIT && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Showing the most recent {ROW_LIMIT} — narrow the filters above to see further back.
        </p>
      )}
    </div>
  );
}

/**
 * States, once, what an operator otherwise has to relearn from every row: a
 * shared-key label is typed, not verified.
 */
function ActorLegend() {
  return (
    <span>
      <span className="pill pill-warn" style={{ marginLeft: 6 }}>
        shared key
      </span>{' '}
      is a name someone typed in, not a verified identity.{' '}
      <span className="pill pill-ok">cognito</span> is a signed-in account.
    </span>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
      <td className="small" style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        {manilaDateTime(entry.created_at)}
      </td>
      <td style={{ padding: '8px 10px' }}>
        <ActorBadge entry={entry} />
      </td>
      <td className="small" style={{ padding: '8px 10px' }}>
        <code style={{ fontSize: '0.85em' }}>{entry.action}</code>
      </td>
      <td className="small muted" style={{ padding: '8px 10px' }}>
        {entry.target_table}
        {entry.target_id && (
          <>
            <br />
            <code style={{ fontSize: '0.8em' }}>{entry.target_id}</code>
          </>
        )}
      </td>
      <td className="small" style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {entry.amount_centavos != null ? money(entry.amount_centavos, entry.currency ?? 'PHP') : ''}
      </td>
      <td className="small muted" style={{ padding: '8px 10px', maxWidth: 320 }}>
        {entry.note ?? ''}
      </td>
    </tr>
  );
}

/**
 * The name, plus what kind of claim it is — never the name alone. See the
 * header comment on why this distinction is the point of the column.
 */
function ActorBadge({ entry }: { entry: AuditEntry }) {
  const pillClass =
    entry.actor_source === 'cognito' ? 'pill pill-ok' : entry.actor_source === 'system' ? 'pill' : 'pill pill-warn';
  const badgeLabel =
    entry.actor_source === 'cognito' ? 'cognito' : entry.actor_source === 'system' ? 'automatic' : 'shared key';

  return (
    <span title={entry.source_ip ?? undefined}>
      <span style={{ display: 'block' }}>{entry.actor_label}</span>
      <span className={pillClass} style={{ marginTop: 4, display: 'inline-block' }}>
        {badgeLabel}
      </span>
    </span>
  );
}

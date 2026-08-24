/**
 * Admin → Registrations: who has a place, who has paid, and what needs a human.
 *
 * The default filter is **Needs attention**, not "everything". A list of every
 * registration ever is a report; the thing an operator opens this screen to do
 * is find the person whose payment is late or whose cancellation nobody has
 * answered. Same reasoning as BookingsTab defaulting to "refunds due".
 *
 * Every action that moves money asks for confirmation and a reason, and both
 * are recorded in the audit trail shown at the bottom of a registration. The
 * audit's actor is the name typed at sign-in, which is an attestation and not
 * authentication — the UI says so rather than implying more than a shared key
 * can prove.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { money } from '../../components/Layout';
import { API_BASE } from '../../config';
import {
  adminListEvents,
  adminGetRoster,
  adminListRegistrations,
  adminGetRegistration,
  adminMarkChargePaid,
  adminSettleChargeWithout,
  adminCancelRegistration,
  adminNudgeRegistration,
  adminActor,
  type AdminEvent,
  type AdminRegistration,
  type AdminCharge,
  type RosterMoney,
  type AuditEntry,
} from '../../lib/cms';

type Filter = 'attention' | 'all' | 'confirmed' | 'cancelled';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'Everything' },
];

const manilaDate = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));

export default function RegistrationsTab({ adminKey }: { adminKey: string }) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [eventId, setEventId] = useState<string>('');
  const [filter, setFilter] = useState<Filter>('attention');
  const [registrations, setRegistrations] = useState<AdminRegistration[] | null>(null);
  const [money_, setMoney] = useState<RosterMoney | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only ticketed events have a roster; a listing-only event has nothing here.
  useEffect(() => {
    adminListEvents(adminKey)
      .then((all) => {
        const ticketed = all.filter((e) => e.ticketing_enabled);
        setEvents(ticketed);
        if (ticketed.length > 0 && !eventId) setEventId(ticketed[0]!.id);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (eventId) {
        const res = await adminGetRoster(adminKey, eventId);
        setRegistrations(res.registrations);
        setMoney(res.money);
      } else {
        setRegistrations(await adminListRegistrations(adminKey));
        setMoney(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adminKey, eventId]);

  useEffect(() => void load(), [load]);

  const shown = useMemo(() => {
    const all = registrations ?? [];
    if (filter === 'all') return all;
    if (filter === 'confirmed') return all.filter((r) => r.status === 'confirmed');
    if (filter === 'cancelled') return all.filter((r) => r.status === 'cancelled');
    return all.filter(
      (r) =>
        r.flagged_at !== null ||
        r.overdueCount > 0 ||
        (r.cancellation_requested_at !== null && r.cancellation_decided_at === null),
    );
  }, [registrations, filter]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 4000);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <select value={eventId} onChange={(e) => setEventId(e.target.value)} style={{ maxWidth: 320 }}>
          <option value="">All ticketed events</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>

        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setFilter(f.key)}
            style={{ padding: '6px 12px' }}
          >
            {f.label}
            {f.key === 'attention' && attentionCount(registrations) > 0 && ` (${attentionCount(registrations)})`}
          </button>
        ))}

        {eventId && (
          <a
            className="btn btn-ghost"
            style={{ padding: '6px 12px' }}
            href={`${API_BASE}/admin/events/${eventId}/roster.csv`}
            onClick={(e) => {
              // The CSV needs the admin key, which a plain <a> cannot send.
              // Fetching it here keeps the header and hands the browser a blob.
              e.preventDefault();
              void downloadCsv(adminKey, eventId).catch((err: Error) => setError(err.message));
            }}
          >
            Export roster (CSV)
          </a>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {money_ && <MoneySummary money={money_} />}

      {registrations === null && !error && <div className="spinner" aria-label="Loading" />}

      {registrations !== null && shown.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>
            {filter === 'attention'
              ? 'Nothing needs attention — every payment is on schedule.'
              : 'No registrations here yet.'}
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {shown.map((r) => (
          <RegistrationRow
            key={r.id}
            adminKey={adminKey}
            registration={r}
            open={openId === r.id}
            onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            onChanged={(message) => {
              flash(message);
              void load();
            }}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

const attentionCount = (rows: AdminRegistration[] | null) =>
  (rows ?? []).filter(
    (r) =>
      r.flagged_at !== null ||
      r.overdueCount > 0 ||
      (r.cancellation_requested_at !== null && r.cancellation_decided_at === null),
  ).length;

/** Fetches the CSV with the admin header, then hands the browser a blob. */
async function downloadCsv(adminKey: string, eventId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/events/${eventId}/roster.csv`, {
    headers: { 'x-admin-key': adminKey, ...(adminActor() ? { 'x-admin-actor': adminActor() } : {}) },
  });
  if (!res.ok) throw new Error('Could not export the roster.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'roster.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function MoneySummary({ money: m }: { money: RosterMoney }) {
  const cards = [
    { label: 'Places', value: `${m.placesTaken} of ${m.capacity}`, hint: `${m.placesFree} free` },
    { label: 'Collected', value: money(m.collectedCentavos, m.currency) },
    { label: 'Outstanding', value: money(m.outstandingCentavos, m.currency) },
    {
      label: 'Overdue',
      value: money(m.overdueCentavos, m.currency),
      danger: m.overdueCentavos > 0,
    },
    { label: 'Expected total', value: money(m.expectedCentavos, m.currency) },
    ...(m.refundsOwedCentavos > 0
      ? [{ label: 'Refunds to send', value: money(m.refundsOwedCentavos, m.currency), danger: true }]
      : []),
  ];

  return (
    <div className="admin-stats-grid" style={{ marginBottom: 16 }}>
      {cards.map((c) => (
        <div className="admin-stat-card" key={c.label}>
          <div className="small muted">{c.label}</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: c.danger ? 'var(--danger)' : undefined }}>
            {c.value}
          </div>
          {c.hint && <div className="small muted">{c.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function RegistrationRow({
  adminKey,
  registration: r,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  adminKey: string;
  registration: AdminRegistration;
  open: boolean;
  onToggle: () => void;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    adminGetRegistration(adminKey, r.id)
      .then((res) => setAudit(res.audit))
      .catch(() => setAudit([]));
  }, [open, adminKey, r.id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged(label);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 0,
          padding: 14,
          cursor: 'pointer',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ minWidth: 34 }} className="small muted">
          #{r.seat_no}
        </span>
        <span style={{ flex: 1, minWidth: 180 }}>
          <strong>{r.registrant_name}</strong>
          <br />
          <span className="small muted">{r.registrant_email}</span>
        </span>
        <span className="small" style={{ minWidth: 150 }}>
          {money(r.paidCentavos, r.currency)} paid
          {r.outstandingCentavos > 0 && (
            <>
              <br />
              <span className="muted">{money(r.outstandingCentavos, r.currency)} left</span>
            </>
          )}
        </span>
        <RowPill registration={r} />
      </button>

      {open && (
        <div style={{ padding: '0 14px 14px', borderTop: '1px solid var(--line)' }}>
          <p className="small muted" style={{ marginTop: 10 }}>
            {r.plan_name} · registered {manilaDate(r.created_at)}
            {r.flag_reason && ` · flagged: ${r.flag_reason}`}
          </p>

          {r.cancellation_requested_at && !r.cancellation_decided_at && (
            <div className="alert alert-info small">
              Cancellation requested {manilaDate(r.cancellation_requested_at)}
              {r.cancellation_reason && `: "${r.cancellation_reason}"`}
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
            <tbody>
              {[...r.charges]
                .sort((a, b) => a.seq - b.seq)
                .map((c) => (
                  <ChargeAdminRow
                    key={c.id}
                    charge={c}
                    busy={busy}
                    onMarkPaid={() => {
                      const method = window.prompt('How was it paid? (bank transfer, GCash, cash)');
                      if (!method) return;
                      const reference = window.prompt('Reference — bank reference, receipt number, etc.');
                      if (!reference) return;
                      void run('Payment recorded — the registrant has been emailed a receipt.', () =>
                        adminMarkChargePaid(adminKey, r.id, c.id, { method, reference }),
                      );
                    }}
                    onWaive={() => {
                      const reason = window.prompt('Why is this being waived? (recorded in the audit trail)');
                      if (!reason) return;
                      void run('Payment waived.', () =>
                        adminSettleChargeWithout(adminKey, r.id, c.id, 'waive', reason),
                      );
                    }}
                    onVoid={() => {
                      const reason = window.prompt('Why is this being voided? (recorded in the audit trail)');
                      if (!reason) return;
                      void run('Payment voided.', () =>
                        adminSettleChargeWithout(adminKey, r.id, c.id, 'void', reason),
                      );
                    }}
                  />
                ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {r.outstandingCentavos > 0 && r.status !== 'cancelled' && (
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('Anything to add to the reminder? (optional)') ?? '';
                  void run('Reminder sent.', () => adminNudgeRegistration(adminKey, r.id, note || undefined));
                }}
              >
                Send a payment reminder
              </button>
            )}

            {r.status !== 'cancelled' && (
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why is this being cancelled? (recorded, and emailed to them)');
                  if (reason === null) return;
                  const refundPesos = window.prompt(
                    `They have paid ${money(r.paidCentavos, r.currency)}.\n\n` +
                      'Refund amount in pesos, or leave blank for none.\n' +
                      'This is recorded only — a person still has to send the money.',
                    '',
                  );
                  if (refundPesos === null) return;
                  const refundCentavos = refundPesos.trim()
                    ? Math.round(Number(refundPesos) * 100)
                    : null;
                  if (refundCentavos !== null && !Number.isFinite(refundCentavos)) {
                    onError('That refund amount is not a number.');
                    return;
                  }
                  if (
                    !window.confirm(
                      `Cancel ${r.registrant_name}'s place and free seat #${r.seat_no}?\n\n` +
                        `Refund recorded: ${refundCentavos ? money(refundCentavos, r.currency) : 'none'}`,
                    )
                  ) {
                    return;
                  }
                  void run('Registration cancelled and the place freed.', () =>
                    adminCancelRegistration(adminKey, r.id, { reason, refundCentavos }),
                  );
                }}
              >
                Cancel this place
              </button>
            )}
          </div>

          {r.refund_centavos != null && r.refund_centavos > 0 && (
            <p className="small" style={{ color: r.refunded_at ? 'var(--muted)' : 'var(--danger)' }}>
              Refund of {money(r.refund_centavos, r.currency)}{' '}
              {r.refunded_at ? `sent ${manilaDate(r.refunded_at)}` : '— not yet sent'}
            </p>
          )}

          <AuditTrail entries={audit} />
        </div>
      )}
    </div>
  );
}

function RowPill({ registration: r }: { registration: AdminRegistration }) {
  if (r.status === 'cancelled') return <span className="pill pill-bad">Cancelled</span>;
  if (r.status === 'expired') return <span className="pill">Lapsed</span>;
  if (r.status === 'pending_payment') return <span className="pill pill-warn">Holding</span>;
  if (r.cancellation_requested_at && !r.cancellation_decided_at) {
    return <span className="pill pill-warn">Cancel requested</span>;
  }
  if (r.overdueCount > 0) return <span className="pill pill-bad">Overdue</span>;
  if (r.flagged_at) return <span className="pill pill-warn">Flagged</span>;
  if (r.outstandingCentavos === 0) return <span className="pill pill-ok">Paid in full</span>;
  return <span className="pill pill-ok">Confirmed</span>;
}

function ChargeAdminRow({
  charge: c,
  busy,
  onMarkPaid,
  onWaive,
  onVoid,
}: {
  charge: AdminCharge;
  busy: boolean;
  onMarkPaid: () => void;
  onWaive: () => void;
  onVoid: () => void;
}) {
  const payable = c.status === 'scheduled' || c.status === 'awaiting_payment';
  const overdue = payable && Date.parse(c.due_at) < Date.now();

  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td style={{ padding: '8px 0' }}>
        <span className="small">{c.label}</span>
        <br />
        <span className="small muted">
          {c.status === 'paid' && c.paid_at
            ? `Paid ${manilaDate(c.paid_at)}${c.paid_method ? ` · ${c.paid_method}` : ''}${c.paid_reference ? ` · ${c.paid_reference}` : ''}${c.receipt_no ? ` · ${c.receipt_no}` : ''}`
            : c.is_deposit
              ? 'Due at registration'
              : `Due ${manilaDate(c.due_at)}`}
          {c.void_reason && ` · ${c.void_reason}`}
        </span>
      </td>
      <td className="small" style={{ padding: '8px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {money(c.amount_centavos, c.currency)}
      </td>
      <td style={{ padding: '8px 0 8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {c.status === 'paid' && <span className="pill pill-ok">Paid</span>}
        {c.status === 'waived' && <span className="pill">Waived</span>}
        {c.status === 'void' && <span className="pill">Void</span>}
        {payable && (
          <>
            <span className={overdue ? 'pill pill-bad' : 'pill pill-warn'}>{overdue ? 'Overdue' : 'Due'}</span>
            <button type="button" className="linklike small" disabled={busy} onClick={onMarkPaid} style={{ marginLeft: 8 }}>
              Mark paid
            </button>
            <button type="button" className="linklike small" disabled={busy} onClick={onWaive} style={{ marginLeft: 8 }}>
              Waive
            </button>
            <button type="button" className="linklike small" disabled={busy} onClick={onVoid} style={{ marginLeft: 8 }}>
              Void
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * What happened to this registration, and who says so.
 *
 * The actor is labelled with its source, because under a shared key a name is
 * something the operator typed — corroborated by the IP and nothing else. Not
 * spelling that out would make the log look like proof of who acted.
 */
function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="small muted" style={{ cursor: 'pointer' }}>
        History ({entries.length})
      </summary>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <tbody>
          {entries.map((a) => (
            <tr key={a.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td className="small" style={{ padding: '6px 0' }}>
                <code style={{ fontSize: '0.85em' }}>{a.action}</code>
                {a.note && (
                  <>
                    <br />
                    <span className="muted">{a.note}</span>
                  </>
                )}
              </td>
              <td className="small muted" style={{ padding: '6px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {a.amount_centavos != null && (
                  <>
                    {money(a.amount_centavos, a.currency ?? 'PHP')}
                    <br />
                  </>
                )}
                {manilaDate(a.created_at)}
                <br />
                <span title={a.source_ip ?? ''}>
                  {a.actor_label}
                  {a.actor_source === 'shared_key' && ' · shared key'}
                  {a.actor_source === 'system' && ' · automatic'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  adminListOrders, adminRetryEnrollment, adminRevokeAccess,
  type AdminOrder,
} from '../../lib/api';
import { money } from '../../components/Layout';
import OrderDetail from './OrderDetail';
import { DataTable, type Column } from './ui/DataTable';
import { useConfirm, useToast } from './ui/feedback';
import { Timeline } from './ui/Timeline';
import { Icon } from './ui/Icon';

/**
 * Admin -> Orders: the course-purchase ledger.
 *
 * Split out of the old Commerce screen (docs/admin-dashboard-plan.md section 4).
 * Now on the shared DataTable: search / sort / page live in the URL, and the
 * status filter is a segmented control with a count per status, computed from
 * the one fetch — the endpoint returns at most 100 rows, so there is nothing
 * the browser does not already hold. `?status=` (or the dashboard's older
 * `?stuck=1`) still selects a filter on arrival; `?view=nosso` shows paid
 * buyers without an SSO identity (the "logged in but sees nothing" case).
 *
 * Retry is safe to click twice, so it is a bulk action with no confirmation.
 * Revoke takes access away and asks first — never in bulk.
 */

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'fulfilled' ? 'pill pill-ok'
    : status === 'failed' ? 'pill pill-bad'
    : status === 'refunded' ? 'pill pill-bad'
    : 'pill pill-warn';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

/** public.order_status (0001), plus two derived views. */
const FILTERS: { key: string; label: string; test: (o: AdminOrder) => boolean }[] = [
  { key: '', label: 'All', test: () => true },
  { key: 'paid_pending_enrollment', label: 'Stuck', test: (o) => o.status === 'paid_pending_enrollment' },
  { key: 'failed', label: 'Failed', test: (o) => o.status === 'failed' },
  { key: 'fulfilled', label: 'Fulfilled', test: (o) => o.status === 'fulfilled' },
  { key: 'refunded', label: 'Refunded', test: (o) => o.status === 'refunded' },
  { key: 'nosso', label: 'No SSO account', test: (o) => !o.cognito_user_sub && o.status !== 'refunded' },
];

const readFilter = (params: URLSearchParams): string => {
  if (params.get('view') === 'nosso') return 'nosso';
  const status = params.get('status') ?? '';
  if (status && FILTERS.some((f) => f.key === status)) return status;
  return params.get('stuck') === '1' ? 'paid_pending_enrollment' : '';
};

const minutesSince = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 60000);
const stuckFor = (iso: string) => {
  const m = minutesSince(iso);
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export default function OrdersTab({ adminKey }: { adminKey: string }) {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const filter = readFilter(params);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    setOrders(await adminListOrders(adminKey));
  }, [adminKey]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  function chooseFilter(key: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('status');
        next.delete('stuck');
        next.delete('view');
        next.delete('page');
        if (key === 'nosso') next.set('view', 'nosso');
        else if (key) next.set('status', key);
        return next;
      },
      { replace: true },
    );
  }

  async function retry(list: AdminOrder[]) {
    setBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const o of list) {
      try {
        const r = await adminRetryEnrollment(adminKey, o.id);
        if (r.status === 'fulfilled') ok++;
        else failures.push(`${o.buyer_email}: ${r.status}`);
      } catch (e) {
        failures.push(`${o.buyer_email}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (ok) toast.success(`${ok} order${ok === 1 ? '' : 's'} enrolled`);
    if (failures.length) toast.error(`Still not enrolled — ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}`);
    await load().catch(() => {});
  }

  async function onRevoke(order: AdminOrder) {
    const yes = await confirm({
      title: 'Revoke course access?',
      body: (
        <>
          <p style={{ marginTop: 0 }}>
            <strong>{order.buyer_email}</strong> loses access to <strong>{order.product_name ?? 'this product'}</strong> and the order
            is marked <em>refunded</em> ({money(order.amount_centavos, order.currency)}).
          </p>
          <p style={{ marginBottom: 0 }}>
            This does <strong>not</strong> move money. Process the refund in the PayMongo dashboard first.
          </p>
        </>
      ),
      confirmLabel: 'Revoke access',
      danger: true,
      typeToConfirm: 'REVOKE',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await adminRevokeAccess(adminKey, order.id);
      const kept = r.retainedCourseIds.length
        ? ` Kept ${r.retainedCourseIds.join(', ')} — still covered by another order.`
        : '';
      toast.success(`Access revoked. Unenrolled from ${r.revokedCourseIds.length} course(s).${kept}`);
      await load();
    } catch (e) {
      toast.error(`Revoke failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of FILTERS) m[f.key] = (orders ?? []).filter(f.test).length;
    return m;
  }, [orders]);

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const rows = useMemo(() => (orders ? orders.filter(active.test) : null), [orders, active]);

  // Per-buyer rollup for the customer summary in the detail panel.
  const byBuyer = useMemo(() => {
    const m = new Map<string, AdminOrder[]>();
    for (const o of orders ?? []) m.set(o.buyer_email, [...(m.get(o.buyer_email) ?? []), o]);
    return m;
  }, [orders]);

  const columns: Column<AdminOrder>[] = [
    {
      key: 'created',
      header: 'Created',
      sortValue: (o) => o.created_at,
      render: (o) => (
        <span className="small" title={new Date(o.created_at).toLocaleString()}>
          {new Date(o.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
          <span className="muted"> {new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        </span>
      ),
    },
    { key: 'buyer', header: 'Buyer', pinned: true, sortValue: (o) => o.buyer_email, render: (o) => <span className="small">{o.buyer_email}</span> },
    { key: 'product', header: 'Product', sortValue: (o) => o.product_name ?? '', render: (o) => <span className="small">{o.product_name ?? <span className="muted">unknown</span>}</span> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (o) => o.amount_centavos, csv: (o) => (o.amount_centavos / 100).toFixed(2), render: (o) => <span className="small">{money(o.amount_centavos, o.currency)}</span> },
    {
      key: 'status',
      header: 'Status',
      sortValue: (o) => o.status,
      render: (o) => (
        <span className="row" style={{ gap: '0.35rem', flexWrap: 'nowrap' }}>
          <StatusPill status={o.status} />
          {o.status === 'paid_pending_enrollment' && (
            <span className={`small ${minutesSince(o.updated_at) > 10 ? 'stat__delta--down' : 'muted'}`} title="Time since the status last changed">
              {stuckFor(o.updated_at)}
            </span>
          )}
        </span>
      ),
    },
    { key: 'sso', header: 'SSO', defaultHidden: true, sortValue: (o) => (o.cognito_user_sub ? 'yes' : 'no'), render: (o) => (o.cognito_user_sub ? <Icon name="check" size={14} /> : <span className="pill pill-warn">none</span>) },
    { key: 'payment', header: 'PayMongo id', defaultHidden: true, sortValue: (o) => o.paymongo_payment_id, render: (o) => <span className="mono">{o.paymongo_payment_id}</span> },
    { key: 'id', header: 'Order id', defaultHidden: true, sortValue: (o) => o.id, render: (o) => <span className="mono">{o.id.slice(0, 8)}…</span> },
    {
      key: 'problem',
      header: 'Problem',
      csv: (o) => o.error_detail,
      render: (o) => <span className="small mono ord-problem">{o.error_detail ? o.error_detail.slice(0, 120) : '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      pinned: true,
      render: (o) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {o.status !== 'fulfilled' && o.status !== 'refunded' && (
            <button className="btn btn-ghost small" onClick={() => void retry([o])} disabled={busy}>
              Retry
            </button>
          )}
          {o.status !== 'refunded' && (
            <button
              className="btn btn-ghost small"
              style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)', borderColor: 'var(--danger-line)' }}
              onClick={() => void onRevoke(o)}
              disabled={busy}
            >
              Revoke
            </button>
          )}
        </span>
      ),
    },
  ];

  const stuckRows = (orders ?? []).filter((o) => o.status === 'paid_pending_enrollment' || o.status === 'failed');

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Orders</h2>
          <p className="small muted">Course purchases. Click a row for payment detail, customer summary and history.</p>
        </div>
        <div className="page-head__actions">
          {stuckRows.length > 0 && (
            <button className="btn btn-primary small" disabled={busy} onClick={() => void retry(stuckRows)}>
              <Icon name="refresh" size={14} /> Retry all {stuckRows.length} unfulfilled
            </button>
          )}
          <button className="btn btn-ghost small" onClick={() => load().catch((e: Error) => setError(e.message))} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="panel">
        <DataTable
          id="orders"
          rows={rows}
          rowKey={(o) => o.id}
          columns={columns}
          searchText={(o) => [o.buyer_email, o.paymongo_payment_id, o.id, o.product_name ?? ''].join(' ')}
          searchPlaceholder="Buyer email, payment id, order id, product…"
          csvName="orders"
          defaultSort={{ key: 'created', dir: 'desc' }}
          rowClassName={(o) => (o.status === 'failed' || (o.status === 'paid_pending_enrollment' && minutesSince(o.updated_at) > 10) ? 'row-alert' : undefined)}
          toolbar={
            <div className="seg" role="group" aria-label="Status">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => chooseFilter(f.key)}>
                  {f.label} <span className="muted">{counts[f.key] ?? 0}</span>
                </button>
              ))}
            </div>
          }
          bulkActions={[{ label: 'Retry enrolment', run: (list) => retry(list.filter((o) => o.status !== 'fulfilled' && o.status !== 'refunded')) }]}
          expand={(o) => (
            <div className="ord-expand-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(240px,1fr)', gap: '1.5rem' }}>
              <div>
                <OrderDetail adminKey={adminKey} order={o} />
                <div className="row" style={{ marginTop: '0.75rem' }}>
                  <a className="btn btn-ghost small" href={`https://dashboard.paymongo.com/payments/${o.paymongo_payment_id}`} target="_blank" rel="noreferrer">
                    Open in PayMongo ↗
                  </a>
                  <button className="btn btn-ghost small" onClick={() => printReceipt(o)}>
                    Print receipt
                  </button>
                  <Link className="btn btn-ghost small" to={`/admin/people?person=${encodeURIComponent(o.buyer_email)}`}>
                    Customer profile
                  </Link>
                </div>
              </div>
              <div className="stack">
                <CustomerSummary orders={byBuyer.get(o.buyer_email) ?? [o]} />
                <Timeline
                  adminKey={adminKey}
                  targetId={o.id}
                  extra={[{ at: o.created_at, label: `Paid — ${money(o.amount_centavos, o.currency)}` }]}
                />
              </div>
            </div>
          )}
          empty={{
            title: filter ? `No ${active.label.toLowerCase()} orders` : 'No orders yet',
            body: filter === 'paid_pending_enrollment' ? 'Every paid order has been enrolled.' : 'Course purchases will appear here as soon as PayMongo confirms them.',
          }}
        />
      </div>
    </div>
  );
}

function CustomerSummary({ orders }: { orders: AdminOrder[] }) {
  const live = orders.filter((o) => o.status !== 'refunded');
  const total = live.reduce((a, o) => a + o.amount_centavos, 0);
  const first = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return (
    <div>
      <div className="timeline__head">Customer</div>
      <div style={{ fontWeight: 700 }}>{orders[0].buyer_email}</div>
      <div className="small muted">
        {money(total, orders[0].currency)} across {live.length} order{live.length === 1 ? '' : 's'} · customer since{' '}
        {new Date(first.created_at).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' })}
      </div>
      {orders.length > 1 && (
        <ul className="small" style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
          {orders.map((o) => (
            <li key={o.id}>
              {o.product_name ?? 'Order'} — {o.status.replace(/_/g, ' ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function printReceipt(o: AdminOrder) {
  const w = window.open('', '_blank', 'width=640,height=720');
  if (!w) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  w.document.write(`<!doctype html><html><head><title>Receipt ${esc(o.id.slice(0, 8))}</title>
<style>body{font-family:Arial,sans-serif;color:#2b332c;max-width:520px;margin:40px auto;padding:0 16px}
h1{font-family:Georgia,serif;color:#2f5e3e;font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:24px 0}
td{padding:8px 0;border-bottom:1px solid #e7e0cc}td:last-child{text-align:right}.muted{color:#6b7568;font-size:13px}
.total td{font-weight:700;border-bottom:0;font-size:16px}</style></head><body>
<h1>Hilom Collective</h1><div class="muted">Official receipt · hilomcollective.com</div>
<table><tr><td>Receipt no.</td><td>${esc(o.id.slice(0, 8).toUpperCase())}</td></tr>
<tr><td>Date</td><td>${esc(new Date(o.created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))}</td></tr>
<tr><td>Billed to</td><td>${esc(o.buyer_email)}</td></tr>
<tr><td>Item</td><td>${esc(o.product_name ?? 'Course')}</td></tr>
<tr><td>Payment reference</td><td>${esc(o.paymongo_payment_id)}</td></tr>
<tr class="total"><td>Total paid</td><td>${esc(money(o.amount_centavos, o.currency))}</td></tr></table>
<div class="muted">Status: ${esc(o.status.replace(/_/g, ' '))}</div>
<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

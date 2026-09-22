import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  adminListOrders, adminRetryEnrollment, adminRevokeAccess,
  type AdminOrder,
} from '../../lib/api';
import { money } from '../../components/Layout';
import OrderDetail from './OrderDetail';

/**
 * Admin -> Orders: the course-purchase ledger.
 *
 * Split out of the old Commerce screen (docs/admin-dashboard-plan.md section 4),
 * where the money record sat below a sync button and a product list in a tab
 * named after its nav group. Retry and Revoke moved here unchanged: one re-runs
 * an enrolment, the other removes somebody's access, and neither is the place
 * to find out a rewrite differed.
 *
 * The "stuck" checkbox is now a status filter beside the others, the pattern
 * BookingsTab uses. `?status=` (or the dashboard's older `?stuck=1`) selects
 * one on arrival.
 */

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'fulfilled' ? 'pill pill-ok'
    : status === 'failed' ? 'pill pill-bad'
    : status === 'refunded' ? 'pill pill-bad'
    : 'pill pill-warn';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

/** Values the backend's `?status=` accepts: public.order_status (0001). */
const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'paid_pending_enrollment', label: 'Stuck' },
  { key: 'failed', label: 'Failed' },
  { key: 'fulfilled', label: 'Fulfilled' },
  { key: 'refunded', label: 'Refunded' },
];

const initialFilter = (params: URLSearchParams): string => {
  const status = params.get('status') ?? '';
  // Non-empty only: '' is the "All" key, and matching it here would swallow
  // the `?stuck=1` fallback below.
  if (status && FILTERS.some((f) => f.key === status)) return status;
  return params.get('stuck') === '1' ? 'paid_pending_enrollment' : '';
};

export default function OrdersTab({ adminKey }: { adminKey: string }) {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(() => initialFilter(searchParams));
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setOrders(await adminListOrders(adminKey, statusFilter || undefined));
  }, [adminKey, statusFilter]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  async function refresh() {
    try {
      setBusy(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function chooseFilter(key: string) {
    setStatusFilter(key);
    // Keep the URL honest, so a reload or a shared link lands on the same view.
    setSearchParams(key ? { status: key } : {}, { replace: true });
  }

  async function onRetry(orderId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await adminRetryEnrollment(adminKey, orderId);
      setNotice(`Order ${orderId.slice(0, 8)}… → ${r.status}`);
      await load();
    } catch (e) {
      setError(`Retry failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(order: AdminOrder) {
    // Revoking takes a paying customer's access away, so it asks first —
    // unlike Retry, which is harmless to click twice.
    const confirmed = window.confirm(
      `Revoke course access for ${order.buyer_email} and mark this order refunded?\n\n` +
        `Process the refund in the PayMongo dashboard first — this does not move any money.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setNotice(null);
    try {
      const r = await adminRevokeAccess(adminKey, order.id);
      const kept = r.retainedCourseIds.length
        ? ` Kept ${r.retainedCourseIds.join(', ')} — still covered by another order.`
        : '';
      setNotice(
        `Order ${order.id.slice(0, 8)}… → ${r.status}. ` +
          `Unenrolled from ${r.revokedCourseIds.length} course(s).${kept}`,
      );
      await load();
    } catch (e) {
      setError(`Revoke failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Client-side because the endpoint returns at most 100 rows anyway, so there
   * is nothing here the browser does not already hold. If that limit ever grows
   * into real pagination this has to move server-side, or search will silently
   * only cover the first page.
   */
  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      [o.buyer_email, o.paymongo_payment_id, o.id, o.product_name ?? '']
        .some((field) => field.toLowerCase().includes(q)),
    );
  }, [orders, query]);

  return (
    <>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Orders</h2>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={statusFilter === f.key ? 'btn btn-primary small' : 'btn btn-ghost small'}
                onClick={() => chooseFilter(f.key)}
                disabled={busy}
              >
                {f.label}
              </button>
            ))}
            <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => refresh()} disabled={busy}>
              Refresh
            </button>
          </div>

          {/* Support arrives with an email address or a payment id from the
              customer, not with a date. Without this the only way to find their
              order was to read down a hundred rows. */}
          <div className="ord-search">
            <input
              type="search"
              value={query}
              placeholder="Search buyer email, payment id, or order id…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search orders"
            />
            {query && (
              <span className="small muted">
                {filteredOrders.length} of {orders.length}
              </span>
            )}
          </div>

          {orders.length === 0 ? (
            <p className="muted" style={{ marginTop: '1rem' }}>No orders{statusFilter ? ` with status “${FILTERS.find((f) => f.key === statusFilter)?.label}”` : ''}.</p>
          ) : filteredOrders.length === 0 ? (
            <p className="muted" style={{ marginTop: '1rem' }}>
              No orders match “{query}”.
            </p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table className="ord-table">
                <thead>
                  <tr>
                    <th aria-label="Expand" /><th>Created</th><th>Buyer</th><th>Product</th>
                    <th>Amount</th><th>Status</th><th>Problem</th><th />
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((o) => {
                    const open = expandedId === o.id;
                    return (
                      <Fragment key={o.id}>
                        <tr className={open ? 'ord-row is-open' : 'ord-row'}>
                          <td>
                            <button
                              type="button"
                              className="ord-expand"
                              aria-expanded={open}
                              aria-label={open ? 'Hide order detail' : 'Show order detail'}
                              onClick={() => setExpandedId(open ? null : o.id)}
                            >
                              <span className={open ? 'ord-caret is-open' : 'ord-caret'}>▸</span>
                            </button>
                          </td>
                          <td className="small">{new Date(o.created_at).toLocaleString()}</td>
                          <td className="small">{o.buyer_email}</td>
                          <td className="small">
                            {o.product_name ?? <span className="muted">unknown</span>}
                          </td>
                          <td className="small">{money(o.amount_centavos, o.currency)}</td>
                          <td><StatusPill status={o.status} /></td>
                          <td className="small mono ord-problem">
                            {o.error_detail ? o.error_detail.slice(0, 160) : '—'}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {o.status !== 'fulfilled' && o.status !== 'refunded' && (
                              <button className="btn btn-ghost small" onClick={() => onRetry(o.id)} disabled={busy}>
                                Retry
                              </button>
                            )}
                            {o.status !== 'refunded' && (
                              <button
                                className="btn btn-ghost small"
                                style={{ marginLeft: '0.35rem', color: '#8c2f1d', borderColor: '#f5c6bd' }}
                                onClick={() => onRevoke(o)}
                                disabled={busy}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr className="ord-detail-row">
                            <td colSpan={8}>
                              <OrderDetail adminKey={adminKey} order={o} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
    </>
  );
}

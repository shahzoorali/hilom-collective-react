import { useCallback, useEffect, useState } from 'react';
import {
  adminListOrders, adminRetryEnrollment, adminSyncCourses, listCourses,
  type AdminOrder, type CourseSummary,
} from '../lib/api';
import { money } from '../components/Layout';

/**
 * Minimal admin panel.
 *
 * Auth is the shared admin key, entered here and kept in sessionStorage only —
 * it is never written to localStorage or a cookie, so it dies with the tab.
 * This is a deliberate stopgap: the plan moves /admin/* behind a Cognito admin
 * group, at which point this key input goes away entirely.
 */

const KEY_STORAGE = 'hilom.adminKey';

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'fulfilled' ? 'pill pill-ok'
    : status === 'failed' ? 'pill pill-bad'
    : 'pill pill-warn';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

export default function Admin() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');
  const [authed, setAuthed] = useState(false);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyStuck, setOnlyStuck] = useState(false);

  const load = useCallback(
    async (key: string, stuckOnly: boolean) => {
      setError(null);
      const rows = await adminListOrders(key, stuckOnly ? 'paid_pending_enrollment' : undefined);
      setOrders(rows);
      setAuthed(true);
      sessionStorage.setItem(KEY_STORAGE, key);
      const c = await listCourses();
      setCourses(c.courses);
      setLastSynced(c.last_synced_at);
    },
    [],
  );

  useEffect(() => {
    if (adminKey) load(adminKey, onlyStuck).catch((e: Error) => setError(e.message));
    // Intentionally runs once on mount with any stored key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh(stuckOnly = onlyStuck) {
    try {
      setBusy(true);
      await load(adminKey, stuckOnly);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onSync() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await adminSyncCourses(adminKey);
      setNotice(`Synced ${r.synced} courses from Moodle.`);
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onRetry(orderId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await adminRetryEnrollment(adminKey, orderId);
      setNotice(`Order ${orderId.slice(0, 8)}… → ${r.status}`);
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Retry failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 420 }}>
          <h1>Admin</h1>
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              refresh();
            }}
          >
            {error && <div className="alert alert-error">{error}</div>}
            <div className="field">
              <label htmlFor="key">Admin key</label>
              <input
                id="key" type="password" value={adminKey} autoComplete="off"
                onChange={(e) => setAdminKey(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy || !adminKey}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </div>
      </section>
    );
  }

  const staleness = lastSynced
    ? `${Math.round((Date.now() - new Date(lastSynced).getTime()) / 3_600_000)}h ago`
    : 'never';

  return (
    <section className="section">
      <div className="container">
        <h1>Admin</h1>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <div className="panel" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.15rem' }}>Course sync</h2>
          <p className="small muted">
            {courses.length} courses cached · last synced <strong>{staleness}</strong>. Sync is
            manual — price or visibility changes made in Moodle won’t appear here until you run it.
          </p>
          <button className="btn btn-primary" onClick={onSync} disabled={busy}>
            {busy ? 'Working…' : 'Sync courses from Moodle'}
          </button>
        </div>

        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Orders</h2>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
              <input
                type="checkbox" style={{ width: 'auto' }} checked={onlyStuck}
                onChange={(e) => {
                  setOnlyStuck(e.target.checked);
                  refresh(e.target.checked);
                }}
              />
              Stuck only
            </label>
            <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => refresh()} disabled={busy}>
              Refresh
            </button>
          </div>

          {orders.length === 0 ? (
            <p className="muted" style={{ marginTop: '1rem' }}>No orders{onlyStuck ? ' needing attention' : ''}.</p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Created</th><th>Buyer</th><th>Amount</th><th>Status</th><th>Problem</th><th />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="small">{new Date(o.created_at).toLocaleString()}</td>
                      <td className="small">{o.buyer_email}</td>
                      <td className="small">{money(o.amount_centavos, o.currency)}</td>
                      <td><StatusPill status={o.status} /></td>
                      <td className="small mono" style={{ maxWidth: 320 }}>
                        {o.error_detail ? o.error_detail.slice(0, 160) : '—'}
                      </td>
                      <td>
                        {o.status !== 'fulfilled' && (
                          <button className="btn btn-ghost small" onClick={() => onRetry(o.id)} disabled={busy}>
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

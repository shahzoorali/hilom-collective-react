import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  adminListOrders, adminListProducts, adminRetryEnrollment, adminRevokeAccess,
  adminSyncCourses, adminUpdateProduct, listCourses,
  type AdminOrder, type AdminProduct, type CourseSummary,
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
    : status === 'refunded' ? 'pill pill-bad'
    : 'pill pill-warn';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

export default function Admin() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');
  const [authed, setAuthed] = useState(false);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  // Price inputs are held as pesos-as-typed strings, not numbers: parsing on
  // every keystroke fights the user mid-edit (e.g. "1499." or a cleared field).
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [descriptionDrafts, setDescriptionDrafts] = useState<Record<string, string>>({});
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
      const prods = await adminListProducts(key);
      setProducts(prods);
      setPriceDrafts(
        Object.fromEntries(prods.map((p) => [p.id, (p.price_centavos / 100).toFixed(2)])),
      );
      setDescriptionDrafts(Object.fromEntries(prods.map((p) => [p.id, p.description ?? ''])));
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

  async function onSavePrice(product: AdminProduct) {
    const raw = (priceDrafts[product.id] ?? '').trim();
    const pesos = Number(raw);
    if (!raw || !Number.isFinite(pesos) || pesos < 0) {
      setError(`"${raw}" is not a valid price.`);
      return;
    }
    // Pesos -> centavos. Math.round avoids float artefacts such as
    // 14.99 * 100 === 1498.9999999999998, which would fail the integer check
    // server-side and reject a perfectly valid price.
    const centavos = Math.round(pesos * 100);
    if (centavos === product.price_centavos) {
      setNotice('Price unchanged.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateProduct(adminKey, product.id, { price_centavos: centavos });
      setNotice(
        `${updated.name}: ${money(product.price_centavos, product.currency)} → ${money(updated.price_centavos, updated.currency)}`,
      );
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Price update failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveDescription(product: AdminProduct) {
    const draft = descriptionDrafts[product.id] ?? '';
    const trimmed = draft.trim();
    if (trimmed === (product.description ?? '')) {
      setNotice('Description unchanged.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateProduct(adminKey, product.id, { description: trimmed });
      setNotice(`${updated.name}: description ${trimmed ? 'updated' : 'cleared'}.`);
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Description update failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleActive(product: AdminProduct) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateProduct(adminKey, product.id, { is_active: !product.is_active });
      setNotice(`${updated.name} is now ${updated.is_active ? 'visible' : 'hidden'} in the catalog.`);
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Update failed: ${(e as Error).message}`);
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
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Revoke failed: ${(e as Error).message}`);
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

        <div className="panel" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.15rem' }}>Products &amp; pricing</h2>
          <p className="small muted">
            Prices are stored in the database, so changes take effect immediately with no deploy.
            Existing orders keep the amount they were actually charged.
          </p>

          {products.length === 0 ? (
            <p className="muted">No products.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Product</th><th>Courses</th><th>Price (PHP)</th><th>Visible</th><th />
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => {
                    const draft = priceDrafts[p.id] ?? '';
                    const dirty = Math.round(Number(draft) * 100) !== p.price_centavos;
                    const descDraft = descriptionDrafts[p.id] ?? '';
                    const descDirty = descDraft.trim() !== (p.description ?? '');
                    return (
                      <Fragment key={p.id}>
                      <tr>
                        <td>
                          <strong>{p.name}</strong>
                          <div className="small muted">{p.slug}</div>
                        </td>
                        <td className="small">
                          {p.product_courses.map((c) => c.moodle_course_id).join(', ') || '—'}
                        </td>
                        <td>
                          <input
                            type="number" min="0" step="0.01" value={draft}
                            style={{ width: 120 }}
                            onChange={(e) =>
                              setPriceDrafts({ ...priceDrafts, [p.id]: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className={p.is_active ? 'pill pill-ok' : 'pill pill-bad'}
                            style={{ border: 0, cursor: 'pointer' }}
                            onClick={() => onToggleActive(p)}
                            disabled={busy}
                            title="Toggle whether this product appears in the public catalog"
                          >
                            {p.is_active ? 'visible' : 'hidden'}
                          </button>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            className="btn btn-primary small"
                            onClick={() => onSavePrice(p)}
                            disabled={busy || !dirty}
                          >
                            Save
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={5} style={{ paddingTop: 0 }}>
                          <label className="small muted" style={{ display: 'block', marginBottom: '0.25rem' }}>
                            Description shown on the public site — left blank shows nothing
                            (no placeholder text).
                          </label>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                            <textarea
                              rows={2}
                              style={{ flex: 1 }}
                              value={descDraft}
                              placeholder="(blank)"
                              onChange={(e) =>
                                setDescriptionDrafts({ ...descriptionDrafts, [p.id]: e.target.value })
                              }
                            />
                            <button
                              className="btn btn-primary small"
                              onClick={() => onSaveDescription(p)}
                              disabled={busy || !descDirty}
                            >
                              Save
                            </button>
                          </div>
                        </td>
                      </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
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

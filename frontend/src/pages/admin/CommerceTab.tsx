import { useCallback, useEffect, useState } from 'react';
import {
  adminListOrders, adminListProducts, adminRetryEnrollment, adminRevokeAccess,
  adminSyncCourses, adminUpdateProduct, listCourses,
  type AdminOrder, type AdminProduct, type CourseSummary,
} from '../../lib/api';
import { money } from '../../components/Layout';

/**
 * Course sync, product pricing, and orders.
 *
 * This was the whole of Admin.tsx before the admin grew tabs; behaviour is
 * unchanged, and the only difference is that the admin key now arrives as a
 * prop instead of being local state with its own sign-in form.
 */

/** A price draft is valid if it parses to a finite, non-negative number. */
function isPriceValid(raw: string) {
  const trimmed = raw.trim();
  const pesos = Number(trimmed);
  return trimmed !== '' && Number.isFinite(pesos) && pesos >= 0;
}

/**
 * Whether a price draft differs from what is stored. An unparseable draft counts
 * as dirty so the card stays in its "unsaved" state and shows the validation
 * hint, rather than looking clean while holding text that would be rejected.
 */
function isPriceDirty(product: AdminProduct, raw: string) {
  if (!isPriceValid(raw)) return true;
  return Math.round(Number(raw.trim()) * 100) !== product.price_centavos;
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'fulfilled' ? 'pill pill-ok'
    : status === 'failed' ? 'pill pill-bad'
    : status === 'refunded' ? 'pill pill-bad'
    : 'pill pill-warn';
  return <span className={cls}>{status.replace(/_/g, ' ')}</span>;
}

export default function CommerceTab({ adminKey }: { adminKey: string }) {
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
    load(adminKey, onlyStuck).catch((e: Error) => setError(e.message));
    // Runs once for the key this tab was opened with.
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

  /**
   * Price and description are edited together on one card, so they save together
   * in one PATCH. Only the fields that actually changed are sent, so saving a
   * description can never silently rewrite a price the user did not touch.
   */
  async function onSaveProduct(product: AdminProduct) {
    const raw = (priceDrafts[product.id] ?? '').trim();
    const trimmedDesc = (descriptionDrafts[product.id] ?? '').trim();

    const patch: { price_centavos?: number; description?: string } = {};

    if (isPriceDirty(product, raw)) {
      if (!isPriceValid(raw)) {
        setError(`"${raw}" is not a valid price.`);
        return;
      }
      // Pesos -> centavos. Math.round avoids float artefacts such as
      // 14.99 * 100 === 1498.9999999999998, which would fail the integer check
      // server-side and reject a perfectly valid price.
      patch.price_centavos = Math.round(Number(raw) * 100);
    }
    if (trimmedDesc !== (product.description ?? '')) patch.description = trimmedDesc;

    if (Object.keys(patch).length === 0) {
      setNotice('Nothing to save.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateProduct(adminKey, product.id, patch);
      const parts: string[] = [];
      if (patch.price_centavos !== undefined) {
        parts.push(
          `${money(product.price_centavos, product.currency)} → ${money(updated.price_centavos, updated.currency)}`,
        );
      }
      if (patch.description !== undefined) {
        parts.push(`description ${patch.description ? 'updated' : 'cleared'}`);
      }
      setNotice(`${updated.name}: ${parts.join(', ')}.`);
      await load(adminKey, onlyStuck);
    } catch (e) {
      setError(`Update failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** Drop local edits and snap both fields back to what the server has. */
  function onDiscard(product: AdminProduct) {
    setPriceDrafts({ ...priceDrafts, [product.id]: (product.price_centavos / 100).toFixed(2) });
    setDescriptionDrafts({ ...descriptionDrafts, [product.id]: product.description ?? '' });
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

  const visibleCount = products.filter((p) => p.is_active).length;

  const staleness = lastSynced
    ? `${Math.round((Date.now() - new Date(lastSynced).getTime()) / 3_600_000)}h ago`
    : 'never';

  return (
    <>
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
          <div className="prod-head">
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Products &amp; pricing</h2>
            {products.length > 0 && (
              <span className="small muted">
                {products.length} product{products.length === 1 ? '' : 's'} ·{' '}
                {visibleCount} visible · {products.length - visibleCount} hidden
              </span>
            )}
          </div>
          {/* The description hint used to be repeated verbatim under every single product
              row. It says the same thing each time, so it belongs here once. */}
          <p className="small muted" style={{ marginBottom: '1.25rem' }}>
            Prices are stored in the database, so changes take effect immediately with no deploy.
            Existing orders keep the amount they were actually charged. A blank description shows
            nothing on the public site — there is no placeholder text.
          </p>

          {products.length === 0 ? (
            <p className="muted">No products.</p>
          ) : (
            /* One card per product rather than two table rows joined by a colSpan.
               The old markup put each description in its own full-width row, which
               made it genuinely hard to see where one product ended and the next
               began, and gave every product two identically-labelled "Save" buttons. */
            <div className="prod-list">
              {products.map((p) => {
                const draft = priceDrafts[p.id] ?? '';
                const descDraft = descriptionDrafts[p.id] ?? '';
                const priceDirty = isPriceDirty(p, draft);
                const descDirty = descDraft.trim() !== (p.description ?? '');
                const dirty = priceDirty || descDirty;
                const priceValid = isPriceValid(draft);
                return (
                  <article
                    key={p.id}
                    className={`prod-card${p.is_active ? '' : ' prod-card--hidden'}${dirty ? ' prod-card--dirty' : ''}`}
                  >
                    <header className="prod-card__head">
                      <div className="prod-card__id">
                        <h3 className="prod-card__name">{p.name}</h3>
                        <div className="prod-card__meta">
                          <code className="prod-card__slug">/{p.slug}</code>
                          <span className="prod-card__courses">
                            {p.product_courses.length === 0 ? (
                              <span className="muted">no courses linked</span>
                            ) : (
                              <>
                                <span className="muted">
                                  {p.product_courses.length === 1 ? 'course' : 'courses'}
                                </span>
                                {p.product_courses.map((c) => (
                                  <span key={c.moodle_course_id} className="prod-chip">
                                    {c.moodle_course_id}
                                  </span>
                                ))}
                              </>
                            )}
                          </span>
                        </div>
                      </div>

                      {/* A pill that happened to be a <button> gave no hint it could be
                          clicked. This reads as a control and states what it will do. */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={p.is_active}
                        className={`prod-toggle${p.is_active ? ' is-on' : ''}`}
                        onClick={() => onToggleActive(p)}
                        disabled={busy}
                        title={
                          p.is_active
                            ? 'Visible in the public catalog — click to hide'
                            : 'Hidden from the public catalog — click to show'
                        }
                      >
                        <span className="prod-toggle__track"><span className="prod-toggle__thumb" /></span>
                        <span className="prod-toggle__label">{p.is_active ? 'Visible' : 'Hidden'}</span>
                      </button>
                    </header>

                    <div className="prod-card__body">
                      <div className="prod-field prod-field--price">
                        <label className="prod-label" htmlFor={`price-${p.id}`}>Price</label>
                        <div className={`prod-price${priceValid ? '' : ' is-invalid'}`}>
                          <span className="prod-price__symbol">₱</span>
                          <input
                            id={`price-${p.id}`}
                            type="number" min="0" step="0.01" value={draft}
                            aria-invalid={!priceValid}
                            onChange={(e) => setPriceDrafts({ ...priceDrafts, [p.id]: e.target.value })}
                          />
                        </div>
                        <span className="prod-hint">
                          {!priceValid
                            ? <span className="prod-hint--bad">Enter a valid amount</span>
                            : priceDirty
                              ? <>was {money(p.price_centavos, p.currency)}</>
                              : <>saved</>}
                        </span>
                      </div>

                      <div className="prod-field prod-field--desc">
                        <label className="prod-label" htmlFor={`desc-${p.id}`}>Description</label>
                        <textarea
                          id={`desc-${p.id}`}
                          rows={2}
                          value={descDraft}
                          placeholder="Nothing shown on the public site"
                          onChange={(e) =>
                            setDescriptionDrafts({ ...descriptionDrafts, [p.id]: e.target.value })
                          }
                        />
                      </div>
                    </div>

                    <footer className="prod-card__foot">
                      <span className="prod-status small">
                        {dirty ? (
                          <>
                            <span className="prod-dot" />
                            Unsaved {[priceDirty && 'price', descDirty && 'description'].filter(Boolean).join(' and ')}
                          </>
                        ) : (
                          <span className="muted">No changes</span>
                        )}
                      </span>
                      {dirty && (
                        <button
                          className="btn btn-ghost small"
                          onClick={() => onDiscard(p)}
                          disabled={busy}
                        >
                          Discard
                        </button>
                      )}
                      {/* One save per product. Price and description are two fields of the
                          same row, so they go up in a single PATCH instead of two buttons
                          racing two requests and two reloads. */}
                      <button
                        className="btn btn-primary small"
                        onClick={() => onSaveProduct(p)}
                        disabled={busy || !dirty || !priceValid}
                      >
                        {busy ? 'Saving…' : 'Save changes'}
                      </button>
                    </footer>
                  </article>
                );
              })}
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
    </>
  );
}

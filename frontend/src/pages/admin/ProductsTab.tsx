import { useCallback, useEffect, useState } from 'react';
import {
  adminListProducts,
  adminListOrders, adminSyncCourses, adminUpdateProduct, listCourses,
  type AdminProduct, type CourseSummary,
} from '../../lib/api';
import { money } from '../../components/Layout';
import type { MediaAsset } from '../../lib/cms';
import { MediaPickerModal } from './MediaLibrary';

/**
 * Admin -> Products & Courses: the catalogue.
 *
 * Split out of the old Commerce screen (docs/admin-dashboard-plan.md section 4),
 * which did three unrelated jobs in one tab. Course sync lives here as an
 * action on the catalogue because that is what it is for: pulling Moodle's
 * course list so the products built on it stay in step. The order ledger moved
 * to OrdersTab.
 *
 * The product-editing code below moved unchanged from CommerceTab.
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

/**
 * Mirrors the server's `normalizeSlugFormat`: kebab-case, lowercase, 1–80 chars.
 * Checked here too so the card can block a save that the API would only reject
 * after a round trip.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isSlugValid(raw: string) {
  const s = raw.trim();
  return s.length > 0 && s.length <= 80 && SLUG_RE.test(s);
}

export default function ProductsTab({ adminKey }: { adminKey: string }) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  // Price inputs are held as pesos-as-typed strings, not numbers: parsing on
  // every keystroke fights the user mid-edit (e.g. "1499." or a cleared field).
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [descriptionDrafts, setDescriptionDrafts] = useState<Record<string, string>>({});
  // Public URL slug, held as typed so a mid-edit value like "alaga-" doesn't
  // fight the user. Validated on blur/save, not per keystroke.
  const [slugDrafts, setSlugDrafts] = useState<Record<string, string>>({});
  // Per-product image override. null = "use the Moodle course image". Set here,
  // it survives a course sync; the mirrored Moodle image does not.
  const [thumbDrafts, setThumbDrafts] = useState<Record<string, string | null>>({});
  const [pickingThumbFor, setPickingThumbFor] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sales per product, from the orders ledger (at most the latest 100 orders —
  // labelled as such where shown).
  const [sales, setSales] = useState<Record<string, { count: number; gross: number; last30: number }> | null>(null);

  const load = useCallback(async (key: string) => {
    setError(null);
    const c = await listCourses();
    setCourses(c.courses);
    setLastSynced(c.last_synced_at);
    const prods = await adminListProducts(key);
    adminListOrders(key)
      .then((orders) => {
        const since = Date.now() - 30 * 86400000;
        const m: Record<string, { count: number; gross: number; last30: number }> = {};
        for (const o of orders) {
          if (o.status === 'refunded') continue;
          const cur = (m[o.product_id] ??= { count: 0, gross: 0, last30: 0 });
          cur.count++;
          cur.gross += o.amount_centavos;
          if (new Date(o.created_at).getTime() >= since) cur.last30++;
        }
        setSales(m);
      })
      .catch(() => setSales({}));
    setProducts(prods);
    setPriceDrafts(
      Object.fromEntries(prods.map((p) => [p.id, (p.price_centavos / 100).toFixed(2)])),
    );
    setDescriptionDrafts(Object.fromEntries(prods.map((p) => [p.id, p.description ?? ''])));
    setSlugDrafts(Object.fromEntries(prods.map((p) => [p.id, p.slug])));
    setThumbDrafts(Object.fromEntries(prods.map((p) => [p.id, p.thumbnail_url])));
  }, []);

  useEffect(() => {
    load(adminKey).catch((e: Error) => setError(e.message));
  }, [adminKey, load]);

  async function onSync() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await adminSyncCourses(adminKey);
      const draftNote = r.drafted.length
        ? ` Created ${r.drafted.length} draft product${r.drafted.length === 1 ? '' : 's'} `
          + `(${r.drafted.map((d) => d.name).join(', ')}) — hidden and unpriced until you set them up.`
        : '';
      setNotice(`Synced ${r.synced} courses from Moodle.${draftNote}`);
      await load(adminKey);
    } catch (e) {
      setError((e as Error).message);
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
    const trimmedSlug = (slugDrafts[product.id] ?? '').trim();
    const thumb = thumbDrafts[product.id] ?? null;

    const patch: {
      price_centavos?: number;
      description?: string;
      thumbnail_url?: string | null;
      slug?: string;
    } = {};

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
    if (thumb !== (product.thumbnail_url ?? null)) patch.thumbnail_url = thumb;
    if (trimmedSlug !== product.slug) {
      if (!isSlugValid(trimmedSlug)) {
        setError(`"${trimmedSlug}" is not a valid slug — use lowercase letters, digits and single hyphens.`);
        return;
      }
      patch.slug = trimmedSlug;
    }

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
      if (patch.thumbnail_url !== undefined) {
        parts.push(`image ${patch.thumbnail_url ? 'updated' : 'cleared'}`);
      }
      if (patch.slug !== undefined) {
        parts.push(`URL → /${updated.slug}`);
      }
      setNotice(`${updated.name}: ${parts.join(', ')}.`);
      await load(adminKey);
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
    setSlugDrafts({ ...slugDrafts, [product.id]: product.slug });
    setThumbDrafts({ ...thumbDrafts, [product.id]: product.thumbnail_url });
  }

  async function onToggleActive(product: AdminProduct) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateProduct(adminKey, product.id, { is_active: !product.is_active });
      setNotice(`${updated.name} is now ${updated.is_active ? 'visible' : 'hidden'} in the catalog.`);
      await load(adminKey);
    } catch (e) {
      setError(`Update failed: ${(e as Error).message}`);
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
                const slugDraft = slugDrafts[p.id] ?? '';
                const thumbDraft = thumbDrafts[p.id] ?? null;
                const priceDirty = isPriceDirty(p, draft);
                const descDirty = descDraft.trim() !== (p.description ?? '');
                const slugDirty = slugDraft.trim() !== p.slug;
                const thumbDirty = thumbDraft !== (p.thumbnail_url ?? null);
                const dirty = priceDirty || descDirty || slugDirty || thumbDirty;
                const priceValid = isPriceValid(draft);
                const slugValid = isSlugValid(slugDraft);
                return (
                  <article
                    key={p.id}
                    className={`prod-card${p.is_active ? '' : ' prod-card--hidden'}${dirty ? ' prod-card--dirty' : ''}`}
                  >
                    {sales && (
                      <div className="small muted" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                        <span><strong style={{ color: 'var(--ink)' }}>{sales[p.id]?.count ?? 0}</strong> sold</span>
                        <span><strong style={{ color: 'var(--ink)' }}>{money(sales[p.id]?.gross ?? 0, p.currency)}</strong> gross</span>
                        <span><strong style={{ color: 'var(--ink)' }}>{sales[p.id]?.last30 ?? 0}</strong> in the last 30 days</span>
                        <span title="The orders endpoint returns the latest 100 orders">(recent orders)</span>
                      </div>
                    )}
                    <header className="prod-card__head">
                      <div className="prod-card__id">
                        <h3 className="prod-card__name">{p.name}</h3>
                        <div className="prod-card__meta">
                          <span className={`prod-card__slug prod-slug${slugValid ? '' : ' is-invalid'}`}>
                            <span aria-hidden="true">/products/</span>
                            <input
                              className="prod-slug__input"
                              value={slugDraft}
                              spellCheck={false}
                              autoCapitalize="off"
                              autoCorrect="off"
                              aria-label={`URL slug for ${p.name}`}
                              aria-invalid={!slugValid}
                              size={Math.max(slugDraft.length, 8)}
                              onChange={(e) =>
                                setSlugDrafts({ ...slugDrafts, [p.id]: e.target.value })
                              }
                            />
                          </span>
                          <span className="prod-card__courses">
                            {p.product_courses.length === 0 ? (
                              <span className="muted">no courses linked</span>
                            ) : (
                              <>
                                <span className="muted">
                                  {p.product_courses.length === 1 ? 'course' : 'courses'}
                                </span>
                                {p.product_courses.map((c) => {
                                  const course = courses.find((x) => x.moodle_course_id === c.moodle_course_id);
                                  return (
                                    <span
                                      key={c.moodle_course_id}
                                      className="prod-chip"
                                      title={course ? `${course.fullname}${course.enrolled_count != null ? ` · ${course.enrolled_count} enrolled` : ''}` : 'Not in the course cache — run a sync'}
                                    >
                                      {c.moodle_course_id}
                                      {course && <span className="muted"> · {course.shortname}</span>}
                                      {course?.enrolled_count != null && <span className="muted"> · {course.enrolled_count} enrolled</span>}
                                    </span>
                                  );
                                })}
                                {p.product_courses.length > 1 && <span className="pill pill-warn" title="One purchase enrolls the buyer in every linked course">bundle</span>}
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

                      <div className="prod-field prod-field--thumb">
                        <label className="prod-label">Catalog image</label>
                        {thumbDraft ? (
                          <img
                            src={thumbDraft}
                            alt=""
                            style={{ width: '100%', maxWidth: 220, borderRadius: 6, display: 'block', marginBottom: '0.4rem' }}
                          />
                        ) : (
                          <p className="small muted" style={{ margin: '0 0 0.4rem' }}>
                            Using the Moodle course image. Set one here to stop sync from
                            overwriting it.
                          </p>
                        )}
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            type="button"
                            className="btn btn-ghost small"
                            onClick={() => setPickingThumbFor(p.id)}
                          >
                            {thumbDraft ? 'Change' : 'Choose image'}
                          </button>
                          {thumbDraft && (
                            <button
                              type="button"
                              className="btn btn-ghost small"
                              onClick={() => setThumbDrafts({ ...thumbDrafts, [p.id]: null })}
                            >
                              Use Moodle image
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {pickingThumbFor === p.id && (
                      <MediaPickerModal
                        adminKey={adminKey}
                        onPick={(asset: MediaAsset) => {
                          setThumbDrafts({ ...thumbDrafts, [p.id]: asset.url });
                          setPickingThumbFor(null);
                        }}
                        onClose={() => setPickingThumbFor(null)}
                      />
                    )}

                    <footer className="prod-card__foot">
                      <span className="prod-status small">
                        {dirty ? (
                          <>
                            <span className="prod-dot" />
                            Unsaved {[priceDirty && 'price', descDirty && 'description', slugDirty && 'URL', thumbDirty && 'image'].filter(Boolean).join(' and ')}
                            {slugDirty && !slugValid && (
                              <span className="prod-hint--bad"> · invalid slug</span>
                            )}
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
                        disabled={busy || !dirty || !priceValid || !slugValid}
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
    </>
  );
}

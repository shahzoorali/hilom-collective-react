/**
 * The media library — elevated asset gallery for imagery across pages, blog posts,
 * and event cards.
 *
 * Supports drag-and-drop uploads directly to S3 via presigned URLs, keyword
 * search filtering, CDN URL copying, and inline alt text editing.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  adminDeleteMedia,
  adminListMedia,
  adminUpdateMedia,
  adminUploadMedia,
  adminListPosts,
  adminListEvents,
  type MediaAsset,
} from '../../lib/cms';

import { adminConfirm, adminToast } from './ui/feedback';
import { Icon } from './ui/Icon';
import { describeSaving } from '../../lib/image-compress';

/** Over this, an image is worth re-exporting before it slows a page down. */
const HEAVY_BYTES = 800 * 1024;
const HEAVY_WIDTH = 2400;
const isHeavy = (a: MediaAsset) => (a.bytes ?? 0) > HEAVY_BYTES || (a.width ?? 0) > HEAVY_WIDTH;
const kb = (b: number | null) => (b == null ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/**
 * Where each asset is used, as far as the list endpoints can tell: post cover
 * images (by URL) and event images (by id). Page bodies aren't in the list
 * response, so an asset used only inside a page reads as "not found in posts
 * or events" rather than "unused" — the label says exactly that.
 */
function useUsage(adminKey: string, enabled: boolean) {
  const [usage, setUsage] = useState<Map<string, string[]> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all([adminListPosts(adminKey).catch(() => []), adminListEvents(adminKey).catch(() => [])]).then(([posts, events]) => {
      if (!live) return;
      const m = new Map<string, string[]>();
      const add = (k: string | null | undefined, label: string) => {
        if (!k) return;
        m.set(k, [...(m.get(k) ?? []), label]);
      };
      for (const p of posts) add(p.image_url, `Post: ${p.title}`);
      for (const e of events) add(e.image_id, `Event: ${e.title}`);
      setUsage(m);
    });
    return () => {
      live = false;
    };
  }, [adminKey, enabled]);
  return usage;
}
function useMediaLibrary(adminKey: string) {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await adminListMedia(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adminKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function upload(files: FileList | File[]) {
    setBusy(true);
    setError(null);
    try {
      const list = Array.from(files);
      const failed: string[] = [];
      // Totals across the batch, so the toast can say how much the compression
      // actually saved rather than just "uploaded 4 images".
      let before = 0;
      let after = 0;
      setProgress({ done: 0, total: list.length });
      for (const [i, file] of list.entries()) {
        try {
          await adminUploadMedia(adminKey, file, (r) => {
            before += r.originalBytes;
            after += r.file.size;
          });
        } catch (e) {
          failed.push(`${file.name}: ${(e as Error).message}`);
        }
        setProgress({ done: i + 1, total: list.length });
      }
      await reload();
      const ok = list.length - failed.length;
      if (ok) {
        const saved = before - after;
        adminToast.success(
          saved > 50 * 1024
            ? `Uploaded ${ok} image${ok === 1 ? '' : 's'} · compressed ${describeSaving(before, after)}`
            : `Uploaded ${ok} image${ok === 1 ? '' : 's'}`,
        );
      }
      if (failed.length) setError(failed.join(' · '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function remove(asset: MediaAsset) {
    if (!(await adminConfirm({ title: `Delete “${asset.filename}”?`, body: 'Any page, post or event still using this image will show a broken image. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    setError(null);
    try {
      await adminDeleteMedia(adminKey, asset.id);
      adminToast.success(`Deleted ${asset.filename}`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setAlt(asset: MediaAsset, alt: string) {
    try {
      await adminUpdateMedia(adminKey, asset.id, alt);
      await reload();
      adminToast.success('Alt text saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { items, error, busy, progress, upload, remove, setAlt, reload };
}

export function MediaGrid({
  adminKey,
  onPick,
}: {
  adminKey: string;
  onPick?: (asset: MediaAsset) => void;
}) {
  const { items, error, busy, progress, upload, remove, setAlt } = useMediaLibrary(adminKey);
  const [issue, setIssue] = useState<'' | 'alt' | 'heavy'>('');
  const usage = useUsage(adminKey, !onPick);
  const [dragging, setDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  }

  function copyUrl(asset: MediaAsset) {
    navigator.clipboard.writeText(asset.url);
    setCopiedId(asset.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  const filteredItems = useMemo(() => {
    const base = items.filter((a) => (issue === 'alt' ? !a.alt?.trim() : issue === 'heavy' ? isHeavy(a) : true));
    if (!searchQuery.trim()) return base;
    const q = searchQuery.toLowerCase();
    return base.filter(
      (a) => a.filename.toLowerCase().includes(q) || (a.alt && a.alt.toLowerCase().includes(q)),
    );
  }, [items, searchQuery, issue]);
  const missingAlt = items.filter((a) => !a.alt?.trim()).length;
  const heavy = items.filter(isHeavy).length;

  return (
    <>
      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {/* Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? 'var(--forest)' : 'var(--line)'}`,
          backgroundColor: dragging ? 'rgba(47, 94, 62, 0.05)' : 'var(--page)',
          borderRadius: 'var(--radius)',
          padding: '1.75rem 1.5rem',
          textAlign: 'center',
          marginBottom: '1.5rem',
          transition: 'all 0.2s ease',
        }}
      >
        <div style={{ marginBottom: '0.4rem', color: 'var(--forest)' }}>
          <Icon name="image" size={28} />
        </div>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: 'var(--forest)' }}>
          {progress ? `Uploading ${progress.done} of ${progress.total}…` : busy ? 'Uploading…' : 'Drag & drop image files here, or browse'}
        </p>
        {progress && (
          <div className="progress" style={{ maxWidth: 280, margin: '0 auto 0.75rem' }}>
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        <label className="btn btn-primary small" style={{ cursor: busy ? 'not-allowed' : 'pointer', display: 'inline-block' }}>
          <span>Choose Files</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            multiple
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
        </label>
        <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
          Supported: JPEG, PNG, WebP, GIF, AVIF (up to 10 MB each). Served via CloudFront Global CDN.
          <br />
          Large images are converted to WebP in your browser before upload — usually a 70–95% saving.
          Animated GIFs are left alone.
        </p>
      </div>

      {/* Media Filter Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <input
          type="text"
          className="search-input"
          placeholder="Filter assets by filename or alt text…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ maxWidth: 360, flex: 1 }}
        />
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={issue === ''} onClick={() => setIssue('')}>All {items.length}</button>
          <button type="button" aria-pressed={issue === 'alt'} onClick={() => setIssue('alt')}>Missing alt {missingAlt}</button>
          <button type="button" aria-pressed={issue === 'heavy'} onClick={() => setIssue('heavy')}>Oversized {heavy}</button>
        </div>
        <span className="small muted">
          {filteredItems.length} {filteredItems.length === 1 ? 'asset' : 'assets'}
        </span>
      </div>

      {filteredItems.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <p className="muted">
            {items.length === 0 ? 'No images uploaded yet.' : 'No assets match your search query.'}
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: '1rem',
          }}
        >
          {filteredItems.map((asset) => (
            <div
              className="card"
              style={{
                padding: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--line)',
                boxShadow: 'var(--shadow)',
              }}
              key={asset.id}
            >
              <div
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  borderRadius: 6,
                  backgroundColor: '#000',
                  aspectRatio: '4/3',
                  marginBottom: '0.6rem',
                }}
              >
                <img
                  src={asset.url}
                  alt={asset.alt ?? ''}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    cursor: onPick ? 'pointer' : 'default',
                    display: 'block',
                    transition: 'transform 0.2s',
                  }}
                  onClick={() => onPick?.(asset)}
                />
              </div>

              <div style={{ flex: 1, minWidth: 0, marginBottom: '0.5rem' }}>
                <p
                  className="small"
                  style={{
                    margin: '0 0 0.35rem',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={asset.filename}
                >
                  {asset.filename}
                </p>
                <p className="small muted" style={{ margin: '0 0 0.35rem', display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {asset.width && asset.height ? `${asset.width}×${asset.height}` : ''} {kb(asset.bytes)}
                  {isHeavy(asset) && <span className="pill pill-warn" title="Over 800 KB or 2400px wide — consider re-exporting">heavy</span>}
                  {!asset.alt?.trim() && <span className="pill pill-warn" title="Screen readers and search engines get nothing">no alt</span>}
                </p>
                {usage && !onPick && (
                  <p className="small muted" style={{ margin: '0 0 0.35rem' }} title={(usage.get(asset.url) ?? usage.get(asset.id) ?? []).join('\n')}>
                    {(() => {
                      const u = [...(usage.get(asset.url) ?? []), ...(usage.get(asset.id) ?? [])];
                      return u.length ? `Used by ${u.length}: ${u[0]}${u.length > 1 ? '…' : ''}` : 'Not found in posts or events';
                    })()}
                  </p>
                )}
                <input
                  className="small"
                  placeholder="Alt description…"
                  defaultValue={asset.alt ?? ''}
                  style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}
                  onBlur={(e) => {
                    if (e.target.value !== (asset.alt ?? '')) void setAlt(asset, e.target.value);
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.35rem', marginTop: 'auto' }}>
                {onPick ? (
                  <button className="btn btn-primary small" style={{ flex: 1 }} onClick={() => onPick(asset)}>
                    Select
                  </button>
                ) : (
                  <button
                    className="btn btn-ghost small"
                    style={{ flex: 1, fontSize: '0.78rem' }}
                    onClick={() => copyUrl(asset)}
                    title="Copy CDN URL"
                  >
                    {copiedId === asset.id ? '✓ Copied' : 'Copy URL'}
                  </button>
                )}
                <button
                  className="btn btn-ghost small"
                  style={{ color: 'var(--danger-fg)', padding: '0.35rem 0.6rem' }}
                  onClick={() => void remove(asset)}
                  title="Delete image"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function MediaPickerModal({
  adminKey,
  onPick,
  onClose,
}: {
  adminKey: string;
  onPick: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div
        className="admin-modal"
        style={{ width: 'min(820px, 95vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-modal-header">
          <h3>Select Media Asset</h3>
          <button className="btn btn-ghost small" onClick={onClose} style={{ padding: '0.2rem 0.5rem' }}>
            ✕
          </button>
        </div>
        <div className="admin-modal-body">
          <MediaGrid adminKey={adminKey} onPick={onPick} />
        </div>
      </div>
    </div>
  );
}

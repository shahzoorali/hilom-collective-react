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
  type MediaAsset,
} from '../../lib/cms';

function useMediaLibrary(adminKey: string) {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      for (const file of Array.from(files)) {
        await adminUploadMedia(adminKey, file);
      }
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(asset: MediaAsset) {
    if (!window.confirm(`Delete "${asset.filename}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await adminDeleteMedia(adminKey, asset.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setAlt(asset: MediaAsset, alt: string) {
    try {
      await adminUpdateMedia(adminKey, asset.id, alt);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { items, error, busy, upload, remove, setAlt, reload };
}

export function MediaGrid({
  adminKey,
  onPick,
}: {
  adminKey: string;
  onPick?: (asset: MediaAsset) => void;
}) {
  const { items, error, busy, upload, remove, setAlt } = useMediaLibrary(adminKey);
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
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (a) => a.filename.toLowerCase().includes(q) || (a.alt && a.alt.toLowerCase().includes(q)),
    );
  }, [items, searchQuery]);

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
        <div style={{ fontSize: '1.8rem', marginBottom: '0.4rem' }}>📁</div>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: 'var(--forest)' }}>
          {busy ? 'Uploading assets…' : 'Drag & drop image files here, or browse'}
        </p>
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
                  ✕
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

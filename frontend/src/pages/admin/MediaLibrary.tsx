/**
 * The media library — used both as a full tab and as a picker modal from any
 * block field of kind `media`.
 *
 * Uploads go presign → PUT straight to S3 → confirm (see adminUploadMedia), so
 * the file never travels through the API.
 */
import { useCallback, useEffect, useState, type DragEvent } from 'react';
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
    if (!window.confirm(`Delete ${asset.filename}? This cannot be undone.`)) return;
    setError(null);
    try {
      await adminDeleteMedia(adminKey, asset.id);
      await reload();
    } catch (e) {
      // The backend refuses with a 409 listing the pages still using it.
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

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? 'var(--forest)' : 'var(--line)'}`,
          borderRadius: 'var(--radius)',
          padding: '1.25rem',
          textAlign: 'center',
          marginBottom: '1rem',
        }}
      >
        <p className="small muted" style={{ margin: '0 0 0.6rem' }}>
          {busy ? 'Uploading…' : 'Drop images here, or'}
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          multiple
          disabled={busy}
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
        <p className="small muted" style={{ margin: '0.6rem 0 0' }}>
          JPEG, PNG, WebP, GIF, or AVIF · up to 10 MB. SVG is not accepted — it can carry script.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="muted">No images yet.</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '0.9rem',
          }}
        >
          {items.map((asset) => (
            <div className="card" style={{ padding: '0.6rem' }} key={asset.id}>
              <img
                src={asset.url}
                alt={asset.alt ?? ''}
                style={{
                  width: '100%',
                  aspectRatio: '4/3',
                  objectFit: 'cover',
                  borderRadius: 6,
                  cursor: onPick ? 'pointer' : 'default',
                }}
                onClick={() => onPick?.(asset)}
              />
              <p className="small" style={{ margin: '0.4rem 0 0.2rem', wordBreak: 'break-all' }}>
                {asset.filename}
              </p>
              <input
                className="small"
                placeholder="Alt text"
                defaultValue={asset.alt ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (asset.alt ?? '')) void setAlt(asset, e.target.value);
                }}
              />
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                {onPick && (
                  <button className="btn btn-primary small" onClick={() => onPick(asset)}>
                    Use
                  </button>
                )}
                <button className="btn btn-ghost small" onClick={() => void remove(asset)}>
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
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '3vh 1rem',
        zIndex: 50,
        overflowY: 'auto',
      }}
    >
      <div
        className="panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 900, width: '100%', background: '#fff' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.8rem' }}>
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Choose an image</h2>
          <button className="btn btn-ghost small" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Close
          </button>
        </div>
        <MediaGrid adminKey={adminKey} onPick={onPick} />
      </div>
    </div>
  );
}

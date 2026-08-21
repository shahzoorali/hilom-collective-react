/**
 * Image picker for Puck's `custom` field — opens the S3-backed media library
 * rather than asking an editor to paste a URL.
 *
 * Stores the same {id, url, alt} shape the backend validates and the renderer
 * reads, so switching editors changed nothing about what is on disk.
 */
import { useState } from 'react';
import type { MediaRef } from '../../cms/blocks';
import type { MediaAsset } from '../../lib/cms';
import { MediaPickerModal } from './MediaLibrary';

export default function MediaField({
  adminKey,
  value,
  onChange,
}: {
  adminKey: string;
  value: MediaRef | undefined;
  onChange: (value: MediaRef | undefined) => void;
}) {
  const [picking, setPicking] = useState(false);

  const pick = (asset: MediaAsset) => {
    onChange({ id: asset.id, url: asset.url, alt: asset.alt ?? '' });
    setPicking(false);
  };

  return (
    <div>
      {value?.url && (
        <img
          src={value.url}
          alt={value.alt}
          style={{ width: '100%', maxWidth: 220, borderRadius: 6, display: 'block', marginBottom: '0.4rem' }}
        />
      )}
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <button type="button" className="btn btn-ghost small" onClick={() => setPicking(true)}>
          {value?.url ? 'Change' : 'Choose image'}
        </button>
        {value?.url && (
          <button type="button" className="btn btn-ghost small" onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>
      {picking && (
        <MediaPickerModal adminKey={adminKey} onPick={pick} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

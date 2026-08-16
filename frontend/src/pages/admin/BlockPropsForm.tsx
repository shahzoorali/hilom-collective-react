/**
 * The block property panel, generated from the catalog in cms/blocks.ts.
 *
 * Generating it means a new block type needs no editor code at all — add the
 * field spec and the renderer component, and the admin form appears. It also
 * removes the class of bug where the editor writes a prop shape the renderer
 * doesn't read.
 */
import { useState } from 'react';
import type { FieldSpec, MediaRef } from '../../cms/blocks';
import type { MediaAsset } from '../../lib/cms';
import { MediaPickerModal } from './MediaLibrary';
import RichTextEditor from './RichTextEditor';

type Values = Record<string, unknown>;

export default function BlockPropsForm({
  adminKey,
  fields,
  values,
  onChange,
}: {
  adminKey: string;
  fields: Record<string, FieldSpec>;
  values: Values;
  onChange: (next: Values) => void;
}) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return <p className="small muted">This block has no settings — its content is fixed in code.</p>;
  }

  return (
    <>
      {entries.map(([name, spec]) => (
        <Field
          key={name}
          adminKey={adminKey}
          spec={spec}
          value={values[name]}
          onChange={(v) => onChange({ ...values, [name]: v })}
        />
      ))}
    </>
  );
}

function Field({
  adminKey,
  spec,
  value,
  onChange,
}: {
  adminKey: string;
  spec: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [picking, setPicking] = useState(false);

  switch (spec.kind) {
    case 'text':
      return (
        <div className="field">
          <label>{spec.label}</label>
          {spec.multiline ? (
            <textarea
              rows={3}
              style={{ width: '100%' }}
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          )}
        </div>
      );

    case 'href':
      return (
        <div className="field">
          <label>{spec.label}</label>
          <input
            value={String(value ?? '')}
            placeholder="/community or https://…"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case 'richtext':
      return (
        <div className="field">
          <label>{spec.label}</label>
          <RichTextEditor value={String(value ?? '')} onChange={onChange} />
        </div>
      );

    case 'boolean':
      return (
        <label className="small" style={{ display: 'flex', gap: '0.5rem', margin: '0 0 0.8rem' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {spec.label}
        </label>
      );

    case 'select':
      return (
        <div className="field">
          <label>{spec.label}</label>
          <select value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(e.target.value)}>
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      );

    case 'media': {
      const current = value as MediaRef | undefined;
      const pick = (asset: MediaAsset) => {
        onChange({ id: asset.id, url: asset.url, alt: asset.alt ?? '' });
        setPicking(false);
      };
      return (
        <div className="field">
          <label>{spec.label}</label>
          {current?.url && (
            <img
              src={current.url}
              alt={current.alt}
              style={{ width: 160, borderRadius: 6, display: 'block', marginBottom: '0.4rem' }}
            />
          )}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button type="button" className="btn btn-ghost small" onClick={() => setPicking(true)}>
              {current?.url ? 'Change' : 'Choose image'}
            </button>
            {current?.url && (
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

    case 'textList': {
      const items = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="field">
          <label>{spec.label}</label>
          {items.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.35rem' }}>
              <textarea
                rows={2}
                style={{ flex: 1 }}
                value={item}
                onChange={(e) => onChange(items.map((v, j) => (j === i ? e.target.value : v)))}
              />
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost small" onClick={() => onChange([...items, ''])}>
            + {spec.itemLabel}
          </button>
        </div>
      );
    }

    case 'group': {
      const groupValue = (value ?? {}) as Values;
      return (
        <fieldset
          style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.8rem', marginBottom: '0.9rem' }}
        >
          <legend className="small muted">{spec.label}</legend>
          <BlockPropsForm adminKey={adminKey} fields={spec.fields} values={groupValue} onChange={onChange} />
        </fieldset>
      );
    }

    case 'list': {
      const items = Array.isArray(value) ? (value as Values[]) : [];
      const replace = (i: number, next: Values) => onChange(items.map((v, j) => (j === i ? next : v)));
      const move = (i: number, delta: number) => {
        const target = i + delta;
        if (target < 0 || target >= items.length) return;
        const next = [...items];
        [next[i], next[target]] = [next[target], next[i]];
        onChange(next);
      };

      return (
        <div className="field">
          <label>{spec.label}</label>
          {items.map((item, i) => (
            <fieldset
              key={i}
              style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.8rem', marginBottom: '0.7rem' }}
            >
              <legend className="small muted">
                {spec.itemLabel} {i + 1}
              </legend>
              <BlockPropsForm
                adminKey={adminKey}
                fields={spec.fields}
                values={item}
                onChange={(next) => replace(i, next)}
              />
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button type="button" className="btn btn-ghost small" onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-ghost small" onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-ghost small"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                >
                  Delete
                </button>
              </div>
            </fieldset>
          ))}
          <button type="button" className="btn btn-ghost small" onClick={() => onChange([...items, {}])}>
            + {spec.itemLabel}
          </button>
        </div>
      );
    }
  }
}

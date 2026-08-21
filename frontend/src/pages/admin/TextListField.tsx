/**
 * Editor for a plain `string[]` prop (the hero's lead paragraphs).
 *
 * Puck's built-in array field holds objects, one field set per row. This field
 * stores bare strings, which is what the backend validates and what the
 * renderer maps over — so a small custom field is cheaper than reshaping the
 * stored data to suit the editor.
 */
export default function TextListField({
  value,
  onChange,
  itemLabel,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  itemLabel: string;
}) {
  return (
    <div>
      {value.map((item, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.35rem' }}>
          <textarea
            rows={2}
            style={{ flex: 1 }}
            value={item}
            onChange={(e) => onChange(value.map((v, j) => (j === i ? e.target.value : v)))}
          />
          <button
            type="button"
            className="btn btn-ghost small"
            title="Remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost small" onClick={() => onChange([...value, ''])}>
        + {itemLabel}
      </button>
    </div>
  );
}

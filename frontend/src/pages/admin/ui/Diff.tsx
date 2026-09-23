/**
 * Field-level before/after for an audit entry. Only keys that changed are
 * shown — a price change on a 30-field row should read as one line.
 */
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v, null, 1));

export function Diff({ before, after }: { before: unknown; after: unknown }) {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (before == null && after == null) return <p className="small muted">No before/after recorded for this entry.</p>;
  if (!isObj(before) || !isObj(after)) {
    return (
      <div className="diff">
        <div className="diff__row diff__head"><div>Value</div><div>Before</div><div>After</div></div>
        <div className="diff__row"><div className="diff__key">—</div><div className="diff__old">{show(before)}</div><div className="diff__new">{show(after)}</div></div>
      </div>
    );
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (!keys.length) return <p className="small muted">Nothing changed between before and after.</p>;
  return (
    <div className="diff">
      <div className="diff__row diff__head"><div>Field</div><div>Before</div><div>After</div></div>
      {keys.map((k) => (
        <div className="diff__row" key={k}>
          <div className="diff__key">{k}</div>
          <div className="diff__old">{show(before[k])}</div>
          <div className="diff__new">{show(after[k])}</div>
        </div>
      ))}
    </div>
  );
}

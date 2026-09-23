/**
 * Small, dependency-free charts for the admin: a sparkline, a bar list and a
 * progress meter. Deliberately minimal — one series, brand colour, the number
 * next to the mark — because these sit inside cards and tables, not reports.
 */

export function Sparkline({
  values,
  width = 160,
  height = 36,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="spark">
      <path d={area} className="spark__area" />
      <path d={line} className="spark__line" />
    </svg>
  );
}

/** Horizontal bars, sorted as given. Values are raw; `format` renders them. */
export function BarList({
  items,
  format = String,
}: {
  items: { label: string; value: number; hint?: string }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="barlist">
      {items.map((it) => (
        <li key={it.label}>
          <div className="barlist__row">
            <span className="barlist__label">{it.label}</span>
            <span className="barlist__value">
              {format(it.value)}
              {it.hint && <span className="muted"> · {it.hint}</span>}
            </span>
          </div>
          <div className="barlist__track">
            <div className="barlist__bar" style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct >= 100 ? 'full' : pct >= 80 ? 'high' : 'ok';
  return (
    <span className="meter" title={label ?? `${value} / ${max}`}>
      <span className="meter__track">
        <span className={`meter__bar meter__bar--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="meter__text">
        {value}/{max}
      </span>
    </span>
  );
}

/** Group values into per-day buckets for the last `days` days (Manila). */
export function dailyBuckets<T>(
  rows: T[],
  at: (r: T) => string,
  value: (r: T) => number,
  days: number,
): { day: string; value: number }[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
  const out = new Map<string, number>();
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) out.set(fmt.format(new Date(now - i * 86400000)), 0);
  for (const r of rows) {
    const d = fmt.format(new Date(at(r)));
    if (out.has(d)) out.set(d, out.get(d)! + value(r));
  }
  return [...out].map(([day, v]) => ({ day, value: v }));
}

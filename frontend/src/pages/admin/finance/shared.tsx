import type { ReactNode } from 'react';
import { money } from '../../../components/Layout';
import { Skeleton } from '../../../components/Skeleton';

/** ₱ with sign for negatives shown as (₱1,234.00), the accounting convention. */
export const php = (c: number | null | undefined) => {
  if (c === null || c === undefined) return '—';
  return c < 0 ? `(${money(-c)})` : money(c);
};

export const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

export function Kpi({
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  label: string;
  value: ReactNode | null;
  hint?: ReactNode;
  tone?: 'attention' | 'alert';
  onClick?: () => void;
}) {
  const cls = `stat ${tone ? `stat--${tone}` : ''}`;
  const body = (
    <>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value === null ? <Skeleton width={120} height={28} /> : value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Delta({ now, before, invert = false }: { now: number; before: number; invert?: boolean }) {
  if (!before) return <span className="muted">no prior month</span>;
  const d = Math.round(((now - before) / Math.abs(before)) * 100);
  const good = invert ? d <= 0 : d >= 0;
  return (
    <span className={good ? 'stat__delta--up' : 'stat__delta--down'}>
      {d >= 0 ? '▲' : '▼'} {Math.abs(d)}% <span className="muted" style={{ fontWeight: 400 }}>vs last month</span>
    </span>
  );
}

const SEVERITY_PILL: Record<string, string> = { high: 'pill pill-bad', medium: 'pill pill-warn', low: 'pill' };
export const SeverityPill = ({ s }: { s: string }) => <span className={SEVERITY_PILL[s] ?? 'pill'}>{s}</span>;

/** Monthly bars: one bar per month, value label on top. Negative months dip below the axis. */
export function MonthBars({
  data,
  format = php,
}: {
  data: { label: string; value: number; secondary?: number }[];
  format?: (v: number) => string;
}) {
  const w = 560;
  const h = 170;
  const pad = 22;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  const min = Math.min(0, ...data.map((d) => Math.min(d.value, d.secondary ?? 0)));
  const span = max - min || 1;
  const y = (v: number) => pad + ((max - v) / span) * (h - pad * 2);
  const slot = w / Math.max(1, data.length);
  const bw = Math.min(46, slot * 0.36);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="fin-bars" role="img" aria-label="Monthly trend">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} className="fin-bars__axis" />
      {data.map((d, i) => {
        const cx = i * slot + slot / 2;
        const top = Math.min(y(0), y(d.value));
        const hh = Math.abs(y(0) - y(d.value));
        return (
          <g key={d.label}>
            {d.secondary !== undefined && (
              <rect
                x={cx - bw - 2}
                y={Math.min(y(0), y(d.secondary))}
                width={bw}
                height={Math.max(1, Math.abs(y(0) - y(d.secondary)))}
                className="fin-bars__secondary"
              >
                <title>{format(d.secondary)}</title>
              </rect>
            )}
            <rect
              x={d.secondary !== undefined ? cx + 2 : cx - bw / 2}
              y={top}
              width={bw}
              height={Math.max(1, hh)}
              className={d.value < 0 ? 'fin-bars__neg' : 'fin-bars__pos'}
            >
              <title>{format(d.value)}</title>
            </rect>
            <text x={cx} y={h - 4} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
      <span>{error}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export const SOURCE_LABEL: Record<string, string> = {
  orders: 'Course order',
  registration_charges: 'Event charge',
  event_registrations: 'Event registration',
  class_registrations: 'Class seat',
  bookings: '1:1 booking',
  booking_packages: 'Session package',
};

/** Where in the admin a source row is worked. */
export const SOURCE_PATH: Record<string, string> = {
  orders: '/admin/orders',
  registration_charges: '/admin/registrations',
  event_registrations: '/admin/registrations',
  class_registrations: '/admin/classes',
  bookings: '/admin/bookings',
  booking_packages: '/admin/bookings',
  events: '/admin/finance/splits',
  expenses: '/admin/finance/expenses',
  reimbursements: '/admin/finance/expenses',
  facilitators: '/admin/finance/payables',
};

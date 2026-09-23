/**
 * A month grid for anything with a start time — bookings, class sessions,
 * events. Manila days, Monday first. Deliberately read-only: clicking an item
 * hands it back to the caller, which already knows how to show its detail.
 */
import { useMemo, useState } from 'react';

export interface CalendarItem {
  id: string;
  at: string;
  label: string;
  tone?: 'ok' | 'warn' | 'bad';
  title?: string;
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
const timeFmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

export function CalendarView({ items, onPick }: { items: CalendarItem[]; onPick?: (id: string) => void }) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = dayKey.format(new Date()).split('-').map(Number);
    return { y, m };
  });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const it of items) {
      const k = dayKey.format(new Date(it.at));
      map.set(k, [...(map.get(k) ?? []), it]);
    }
    for (const list of map.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    return map;
  }, [items]);

  const first = new Date(Date.UTC(cursor.y, cursor.m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - lead * 86400000);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000));
  const today = dayKey.format(new Date());
  const monthLabel = first.toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const inMonth = items.filter((it) => dayKey.format(new Date(it.at)).startsWith(`${cursor.y}-${String(cursor.m).padStart(2, '0')}`)).length;

  const shift = (d: number) =>
    setCursor(({ y, m }) => {
      const n = m + d;
      return n < 1 ? { y: y - 1, m: 12 } : n > 12 ? { y: y + 1, m: 1 } : { y, m: n };
    });

  return (
    <div className="cal">
      <div className="cal__head">
        <button type="button" className="btn btn-ghost small" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <strong>
          {monthLabel} <span className="small muted">· {inMonth} item{inMonth === 1 ? '' : 's'}</span>
        </strong>
        <span className="row" style={{ gap: '0.3rem' }}>
          <button
            type="button"
            className="btn btn-ghost small"
            onClick={() => {
              const [y, m] = today.split('-').map(Number);
              setCursor({ y, m });
            }}
          >
            Today
          </button>
          <button type="button" className="btn btn-ghost small" onClick={() => shift(1)} aria-label="Next month">›</button>
        </span>
      </div>
      <div className="cal__grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="cal__dow">{d}</div>
        ))}
        {cells.map((d) => {
          const k = d.toISOString().slice(0, 10);
          const list = byDay.get(k) ?? [];
          const out = d.getUTCMonth() !== cursor.m - 1;
          return (
            <div key={k} className={`cal__day ${out ? 'cal__day--out' : ''} ${k === today ? 'cal__day--today' : ''}`}>
              <span className="cal__num">{d.getUTCDate()}</span>
              {list.slice(0, 4).map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`cal__ev ${it.tone && it.tone !== 'ok' ? `cal__ev--${it.tone}` : ''}`}
                  title={it.title ?? `${timeFmt.format(new Date(it.at))} ${it.label}`}
                  onClick={() => onPick?.(it.id)}
                  style={{ cursor: onPick ? 'pointer' : 'default' }}
                >
                  {timeFmt.format(new Date(it.at))} {it.label}
                </button>
              ))}
              {list.length > 4 && <span className="small muted">+{list.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

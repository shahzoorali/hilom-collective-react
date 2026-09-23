/**
 * The one admin table.
 *
 * Every list in the admin used to hand-roll its own <table>, so each one had a
 * different subset of search / sort / paging, and most had none. This gives
 * every list the same behaviour:
 *
 *  - search, sort and page live in the URL, so a filtered view is a link you
 *    can paste to a colleague and the back button undoes a filter;
 *  - "Showing 1–25 of 312" so a truncated list never reads as the whole list;
 *  - saved views (a named URL query, kept per browser) for the filters you
 *    reach for every morning;
 *  - pick-your-columns, remembered per table;
 *  - row selection with bulk actions;
 *  - CSV export of exactly what is filtered;
 *  - a skeleton while loading and a real empty state instead of a blank box.
 *
 * All of it is client-side over rows already fetched. The admin lists are
 * hundreds of rows, not millions, and the backends already cap what they send.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from './Icon';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Value for CSV export. Falls back to sortValue. Omit both to leave the column out of CSV. */
  csv?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** Starts hidden in the column picker. */
  defaultHidden?: boolean;
  /** Can't be hidden (the identifying column). */
  pinned?: boolean;
  width?: string;
}

export interface BulkAction<T> {
  label: string;
  danger?: boolean;
  run: (rows: T[]) => void | Promise<void>;
}

export interface DataTableProps<T> {
  /** Stable id: namespaces column prefs and saved views in localStorage. */
  id: string;
  rows: T[] | null;
  rowKey: (row: T) => string;
  columns: Column<T>[];
  loading?: boolean;
  /** Text searched by the search box. Omit to hide the box. */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  /** Extra controls rendered in the toolbar (status filters etc.). */
  toolbar?: ReactNode;
  bulkActions?: BulkAction<T>[];
  onRowClick?: (row: T) => void;
  /** Rendered under a row when it's clicked open (instead of onRowClick). */
  expand?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  empty?: { title: string; body?: ReactNode; action?: ReactNode };
  pageSize?: number;
  /** File name stem for CSV export. Omit to hide the button. */
  csvName?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** URL param prefix, when two tables share a page. */
  urlPrefix?: string;
}

const readJson = <V,>(key: string, fallback: V): V => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as V) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode — prefs just don't persist */
  }
};

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    id,
    rows,
    rowKey,
    columns,
    loading,
    searchText,
    searchPlaceholder = 'Search…',
    toolbar,
    bulkActions,
    onRowClick,
    expand,
    rowClassName,
    empty,
    pageSize = 25,
    csvName,
    defaultSort,
    urlPrefix = '',
  } = props;

  const [params, setParams] = useSearchParams();
  const p = (k: string) => `${urlPrefix}${k}`;
  const q = params.get(p('q')) ?? '';
  const sortKey = params.get(p('sort')) ?? defaultSort?.key ?? '';
  const sortDir = (params.get(p('dir')) as 'asc' | 'desc') ?? defaultSort?.dir ?? 'asc';
  const page = Math.max(1, Number(params.get(p('page')) ?? 1) || 1);

  const [qDraft, setQDraft] = useState(q);
  useEffect(() => setQDraft(q), [q]);

  const update = (patch: Record<string, string | null>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || v === '') next.delete(p(k));
          else next.set(p(k), v);
        }
        return next;
      },
      { replace: true },
    );
  };

  // Debounce search typing into the URL.
  useEffect(() => {
    if (qDraft === q) return;
    const t = window.setTimeout(() => update({ q: qDraft, page: null }), 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  // --- columns ---
  const colKey = `hilom.admin.table.${id}.hidden`;
  const [hidden, setHidden] = useState<string[]>(() =>
    readJson(colKey, columns.filter((c) => c.defaultHidden).map((c) => c.key)),
  );
  const visible = columns.filter((c) => c.pinned || !hidden.includes(c.key));
  const toggleCol = (k: string) => {
    const next = hidden.includes(k) ? hidden.filter((h) => h !== k) : [...hidden, k];
    setHidden(next);
    writeJson(colKey, next);
  };

  // --- saved views ---
  const viewsKey = `hilom.admin.table.${id}.views`;
  const [views, setViews] = useState<{ name: string; query: string }[]>(() => readJson(viewsKey, []));
  const currentQuery = (() => {
    const c = new URLSearchParams(params);
    c.delete(p('page'));
    return c.toString();
  })();
  const saveView = () => {
    const name = window.prompt('Name this view', '')?.trim();
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, query: currentQuery }];
    setViews(next);
    writeJson(viewsKey, next);
  };
  const removeView = (name: string) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeJson(viewsKey, next);
  };

  // --- data pipeline ---
  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    let out = needle && searchText ? rows.filter((r) => searchText(r).toLowerCase().includes(needle)) : rows;
    const col = columns.find((c) => c.key === sortKey);
    if (col?.sortValue) {
      const sv = col.sortValue;
      out = [...out].sort((a, b) => {
        const x = sv(a);
        const y = sv(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, q, searchText, columns, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // --- selection ---
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [rows]);
  const selectedRows = filtered.filter((r) => selected.has(rowKey(r)));
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.has(rowKey(r)));
  const togglePage = () => {
    const next = new Set(selected);
    for (const r of pageRows) {
      if (allOnPage) next.delete(rowKey(r));
      else next.add(rowKey(r));
    }
    setSelected(next);
  };
  const toggleRow = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };
  const [bulkBusy, setBulkBusy] = useState(false);

  const [open, setOpen] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colMenu) return;
    const close = (e: MouseEvent) => {
      if (!colMenuRef.current?.contains(e.target as Node)) setColMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [colMenu]);

  const exportCsv = () => {
    const cols = columns.filter((c) => c.csv || c.sortValue);
    downloadCsv(
      csvName ?? id,
      cols.map((c) => c.header),
      (selectedRows.length ? selectedRows : filtered).map((r) => cols.map((c) => (c.csv ?? c.sortValue)!(r))),
    );
  };

  const onSort = (c: Column<T>) => {
    if (!c.sortValue) return;
    const dir = sortKey === c.key && sortDir === 'asc' ? 'desc' : 'asc';
    update({ sort: c.key, dir, page: null });
  };

  const hasBulk = Boolean(bulkActions?.length);
  const colSpan = visible.length + (hasBulk ? 1 : 0);

  return (
    <div className="dt">
      <div className="dt__toolbar">
        {searchText && (
          <div className="dt__search">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={qDraft}
              placeholder={searchPlaceholder}
              onChange={(e) => setQDraft(e.target.value)}
              aria-label="Search"
            />
          </div>
        )}
        {toolbar}
        <div className="dt__toolbar-end">
          <div className="dt__menu" ref={colMenuRef}>
            <button type="button" className="btn btn-ghost small" onClick={() => setColMenu((v) => !v)}>
              <Icon name="columns" size={14} /> Columns
            </button>
            {colMenu && (
              <div className="dt__menu-pop">
                {columns.map((c) => (
                  <label key={c.key} className="dt__menu-item">
                    <input
                      type="checkbox"
                      checked={c.pinned || !hidden.includes(c.key)}
                      disabled={c.pinned}
                      onChange={() => toggleCol(c.key)}
                    />
                    {c.header || c.key}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost small" onClick={saveView} title="Save the current filters as a view">
            <Icon name="bookmark" size={14} /> Save view
          </button>
          {csvName !== undefined && (
            <button type="button" className="btn btn-ghost small" onClick={exportCsv} disabled={!filtered.length}>
              <Icon name="download" size={14} /> {selectedRows.length ? `Export ${selectedRows.length}` : 'Export'}
            </button>
          )}
        </div>
      </div>

      {views.length > 0 && (
        <div className="dt__views">
          <span className="small muted">Views:</span>
          {views.map((v) => (
            <span key={v.name} className={`dt__chip ${v.query === currentQuery ? 'dt__chip--on' : ''}`}>
              <button type="button" onClick={() => setParams(new URLSearchParams(v.query), { replace: true })}>
                {v.name}
              </button>
              <button type="button" aria-label={`Remove view ${v.name}`} onClick={() => removeView(v.name)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {hasBulk && selectedRows.length > 0 && (
        <div className="dt__bulk" role="region" aria-label="Bulk actions">
          <strong>{selectedRows.length} selected</strong>
          {bulkActions!.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={bulkBusy}
              className={`btn small ${a.danger ? 'btn-danger' : 'btn-ghost'}`}
              onClick={async () => {
                setBulkBusy(true);
                try {
                  await a.run(selectedRows);
                  setSelected(new Set());
                } finally {
                  setBulkBusy(false);
                }
              }}
            >
              {a.label}
            </button>
          ))}
          <button type="button" className="btn-link small" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="dt__scroll">
        <table className="dt__table">
          <thead>
            <tr>
              {hasBulk && (
                <th className="dt__check">
                  <input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select page" />
                </th>
              )}
              {visible.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    style={{ textAlign: c.align, width: c.width }}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sortValue ? (
                      <button type="button" className={`dt__sort ${active ? 'dt__sort--on' : ''}`} onClick={() => onSort(c)}>
                        {c.header}
                        <span aria-hidden="true">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(loading || rows == null) &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk${i}`} aria-hidden="true">
                  {Array.from({ length: colSpan }).map((__, j) => (
                    <td key={j}>
                      <span className="skeleton" style={{ display: 'block', height: '0.9em', width: `${50 + ((i * 7 + j * 13) % 45)}%` }} />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              rows != null &&
              pageRows.map((r) => {
                const k = rowKey(r);
                const isOpen = open === k;
                const clickable = Boolean(onRowClick || expand);
                return (
                  <FragmentRow key={k}>
                    <tr
                      className={[clickable ? 'dt__row--click' : '', selected.has(k) ? 'dt__row--sel' : '', rowClassName?.(r) ?? '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
                        if (expand) setOpen(isOpen ? null : k);
                        else onRowClick?.(r);
                      }}
                    >
                      {hasBulk && (
                        <td className="dt__check">
                          <input type="checkbox" checked={selected.has(k)} onChange={() => toggleRow(k)} aria-label="Select row" />
                        </td>
                      )}
                      {visible.map((c) => (
                        <td key={c.key} style={{ textAlign: c.align }}>
                          {c.render ? c.render(r) : String((c.sortValue?.(r) ?? '') as string)}
                        </td>
                      ))}
                    </tr>
                    {expand && isOpen && (
                      <tr className="dt__expand">
                        <td colSpan={colSpan}>{expand(r)}</td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
          </tbody>
        </table>
        {!loading && rows != null && filtered.length === 0 && (
          q && rows.length > 0 ? (
            <EmptyState
              icon="search"
              title={`Nothing matches “${q}”`}
              body="Try a shorter search, or clear it."
              action={
                <button type="button" className="btn btn-ghost small" onClick={() => update({ q: null })}>
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState title={empty?.title ?? 'Nothing here yet'} body={empty?.body} action={empty?.action} />
          )
        )}
      </div>

      {!loading && rows != null && filtered.length > 0 && (
        <div className="dt__footer">
          <span className="small muted">
            Showing {start + 1}–{Math.min(start + pageSize, filtered.length)} of {filtered.length}
            {filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ''}
          </span>
          {pages > 1 && (
            <div className="dt__pager">
              <button type="button" className="btn btn-ghost small" disabled={safePage <= 1} onClick={() => update({ page: String(safePage - 1) })}>
                ‹ Prev
              </button>
              <span className="small">
                Page {safePage} of {pages}
              </span>
              <button type="button" className="btn btn-ghost small" disabled={safePage >= pages} onClick={() => update({ page: String(safePage + 1) })}>
                Next ›
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

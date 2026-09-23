/**
 * ⌘K / Ctrl+K: jump anywhere in the admin.
 *
 * Type a screen name to go there, or a name / email / order id to land on that
 * person's profile or that order. Records are fetched the first time the
 * palette opens and kept for the session — the lists are small, and a palette
 * that waits on the network per keystroke isn't one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminListOrders, type AdminOrder } from '../../../lib/api';
import {
  adminListEvents,
  adminListPages,
  adminListPeople,
  adminListPosts,
  type AdminEvent,
  type AdminPage,
  type AdminPost,
  type Person,
} from '../../../lib/cms';
import { money } from '../../../components/Layout';
import { Icon, type IconName } from './Icon';

export interface PaletteNavItem {
  label: string;
  path: string;
  icon: IconName;
  group: string;
}

interface Result {
  id: string;
  kind: string;
  icon: IconName;
  title: string;
  sub?: string;
  to: string;
}

interface Index {
  people: Person[];
  orders: AdminOrder[];
  events: AdminEvent[];
  pages: AdminPage[];
  posts: AdminPost[];
}

export function CommandPalette({ adminKey, nav }: { adminKey: string; nav: PaletteNavItem[] }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [index, setIndex] = useState<Index | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hilom:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hilom:open-palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    if (index || loading) return;
    setLoading(true);
    const safe = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    Promise.all([
      safe(adminListPeople(adminKey).then((r) => r.people), [] as Person[]),
      safe(adminListOrders(adminKey), [] as AdminOrder[]),
      safe(adminListEvents(adminKey), [] as AdminEvent[]),
      safe(adminListPages(adminKey), [] as AdminPage[]),
      safe(adminListPosts(adminKey), [] as AdminPost[]),
    ])
      .then(([people, orders, events, pages, posts]) => setIndex({ people, orders, events, pages, posts }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    const has = (...s: (string | null | undefined)[]) => s.some((x) => x?.toLowerCase().includes(needle));
    const navHits: Result[] = nav
      .filter((n) => !needle || has(n.label, n.group))
      .map((n) => ({ id: `nav:${n.path}`, kind: 'Go to', icon: n.icon, title: n.label, sub: n.group, to: `/admin/${n.path}` }));
    if (!needle || !index) return navHits.slice(0, needle ? 8 : 30);

    const people: Result[] = index.people
      .filter((p) => has(p.email, p.full_name))
      .slice(0, 6)
      .map((p) => ({
        id: `p:${p.email}`,
        kind: 'Person',
        icon: 'users',
        title: p.full_name || p.email,
        sub: `${p.email} · ${money(p.lifetime_centavos, 'PHP')} lifetime`,
        to: `/admin/people?person=${encodeURIComponent(p.email)}`,
      }));
    const orders: Result[] = index.orders
      .filter((o) => has(o.id, o.buyer_email, o.paymongo_payment_id, o.product_name))
      .slice(0, 6)
      .map((o) => ({
        id: `o:${o.id}`,
        kind: 'Order',
        icon: 'card',
        title: `${o.product_name ?? 'Order'} — ${money(o.amount_centavos, o.currency)}`,
        sub: `${o.buyer_email} · ${o.status.replace(/_/g, ' ')}`,
        to: `/admin/orders?q=${encodeURIComponent(o.id)}`,
      }));
    const events: Result[] = index.events
      .filter((e) => has(e.title))
      .slice(0, 4)
      .map((e) => ({ id: `e:${e.id}`, kind: 'Event', icon: 'calendar', title: e.title, sub: e.status, to: `/admin/events?q=${encodeURIComponent(e.title)}` }));
    const pages: Result[] = index.pages
      .filter((p) => has(p.title, p.slug))
      .slice(0, 4)
      .map((p) => ({ id: `pg:${p.id}`, kind: 'Page', icon: 'file', title: p.title, sub: `/${p.slug}`, to: `/admin/pages/${p.id}` }));
    const posts: Result[] = index.posts
      .filter((p) => has(p.title, p.slug))
      .slice(0, 4)
      .map((p) => ({ id: `po:${p.id}`, kind: 'Post', icon: 'pen', title: p.title, sub: `/${p.slug}`, to: `/admin/posts/${p.id}` }));
    return [...navHits.slice(0, 5), ...people, ...orders, ...events, ...pages, ...posts];
  }, [q, index, nav]);

  useEffect(() => setCursor(0), [q]);

  if (!open) return null;

  const go = (r: Result | undefined) => {
    if (!r) return;
    setOpen(false);
    navigate(r.to);
  };

  return (
    <div className="admin-modal-overlay cmdk-overlay" onClick={() => setOpen(false)}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search the admin" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk__input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search people, orders, events, pages… or jump to a screen"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                go(results[cursor]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="cmdk__list" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.id}
              role="option"
              aria-selected={i === cursor}
              className={`cmdk__item ${i === cursor ? 'cmdk__item--on' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(r)}
            >
              <Icon name={r.icon} size={16} />
              <div className="cmdk__text">
                <div className="cmdk__title">{r.title}</div>
                {r.sub && <div className="cmdk__sub">{r.sub}</div>}
              </div>
              <span className="cmdk__kind">{r.kind}</span>
            </li>
          ))}
          {results.length === 0 && (
            <li className="cmdk__empty">{loading ? 'Loading records…' : `No matches for “${q}”.`}</li>
          )}
        </ul>
        {loading && q && <div className="cmdk__foot small muted">Still loading records — results will fill in.</div>}
      </div>
    </div>
  );
}

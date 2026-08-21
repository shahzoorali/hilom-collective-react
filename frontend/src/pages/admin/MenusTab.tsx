/**
 * Header and footer navigation menu editor.
 *
 * Provides an elevated drag/reorder interface, link datalist auto-completion
 * from CMS pages, target tab selector, and visibility switches.
 */
import { useEffect, useState } from 'react';
import { adminGetMenus, adminSaveMenu, listPages, type AdminMenu } from '../../lib/cms';

type Item = AdminMenu['items'][number];

const blank = (): Item => ({ label: '', href: '/', target: 'self', visible: true, children: [] });

export default function MenusTab({ adminKey }: { adminKey: string }) {
  const [menus, setMenus] = useState<AdminMenu[]>([]);
  const [slugs, setSlugs] = useState<{ slug: string; title: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminGetMenus(adminKey).then(setMenus).catch((e: Error) => setError(e.message));
    listPages().then(setSlugs).catch(() => setSlugs([]));
  }, [adminKey]);

  function patch(menuKey: string, items: Item[]) {
    setMenus((prev) => prev.map((m) => (m.key === menuKey ? { ...m, items } : m)));
  }

  async function save(menu: AdminMenu) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setMenus(await adminSaveMenu(adminKey, menu.key, menu.items));
      setNotice(`${menu.label} saved successfully.`);
      setTimeout(() => setNotice(null), 3500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '1rem' }}>{notice}</div>}

      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>Navigation Menus</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Manage links appearing in the global site header navigation bar and footer columns.
        </p>
      </div>

      {menus.length === 0 ? (
        <div className="panel" style={{ textAlign: 'center', padding: '2rem' }}>
          <p className="muted">Loading menus…</p>
        </div>
      ) : (
        menus.map((menu) => (
          <div className="panel" style={{ marginBottom: '1.5rem' }} key={menu.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--line)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ fontSize: '1.15rem', margin: 0, color: 'var(--forest)' }}>{menu.label}</h3>
                <span className="small muted">
                  Key: <code>{menu.key}</code> • {menu.items.length} {menu.items.length === 1 ? 'link' : 'links'}
                </span>
              </div>
              <button className="btn btn-primary small" onClick={() => save(menu)} disabled={busy}>
                {busy ? 'Saving…' : `Save ${menu.label}`}
              </button>
            </div>

            {menu.items.length === 0 ? (
              <p className="muted" style={{ padding: '1rem 0' }}>No links configured in this menu.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {menu.items.map((item, i) => {
                  const replace = (next: Partial<Item>) =>
                    patch(menu.key, menu.items.map((v, j) => (j === i ? { ...v, ...next } : v)));
                  const move = (delta: number) => {
                    const target = i + delta;
                    if (target < 0 || target >= menu.items.length) return;
                    const next = [...menu.items];
                    [next[i], next[target]] = [next[target], next[i]];
                    patch(menu.key, next);
                  };

                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        padding: '0.6rem 0.75rem',
                        background: item.visible ? 'var(--page)' : 'rgba(0,0,0,0.03)',
                        opacity: item.visible ? 1 : 0.6,
                        borderRadius: 'var(--radius)',
                        border: '1px solid var(--line)',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <button
                          type="button"
                          className="btn btn-ghost small"
                          style={{ padding: '0.1rem 0.4rem', fontSize: '0.75rem' }}
                          onClick={() => move(-1)}
                          disabled={i === 0}
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost small"
                          style={{ padding: '0.1rem 0.4rem', fontSize: '0.75rem' }}
                          onClick={() => move(1)}
                          disabled={i === menu.items.length - 1}
                          title="Move down"
                        >
                          ▼
                        </button>
                      </div>

                      <div style={{ flex: '1 1 180px' }}>
                        <input
                          placeholder="Link label (e.g. 'About Us')"
                          value={item.label}
                          onChange={(e) => replace({ label: e.target.value })}
                          style={{ fontWeight: 600 }}
                        />
                      </div>

                      <div style={{ flex: '1 1 220px' }}>
                        <input
                          placeholder="/about or https://…"
                          value={item.href}
                          onChange={(e) => replace({ href: e.target.value })}
                          list="cms-page-slugs"
                        />
                      </div>

                      <select
                        value={item.target}
                        onChange={(e) => replace({ target: e.target.value as 'self' | 'blank' })}
                        style={{ width: 'auto' }}
                      >
                        <option value="self">Same tab</option>
                        <option value="blank">New tab ↗</option>
                      </select>

                      <label className="small" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', margin: 0, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          checked={item.visible}
                          onChange={(e) => replace({ visible: e.target.checked })}
                        />
                        <span>Visible</span>
                      </label>

                      <button
                        type="button"
                        className="btn btn-ghost small"
                        onClick={() => patch(menu.key, menu.items.filter((_, j) => j !== i))}
                        title="Remove link"
                        style={{ color: 'var(--danger-fg)' }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--line)' }}>
              <button className="btn btn-ghost small" onClick={() => patch(menu.key, [...menu.items, blank()])}>
                + Add Navigation Link
              </button>
              <button className="btn btn-primary small" onClick={() => save(menu)} disabled={busy}>
                Save {menu.label}
              </button>
            </div>
          </div>
        ))
      )}

      <datalist id="cms-page-slugs">
        {slugs.map((page) => (
          <option key={page.slug} value={`/${page.slug === 'home' ? '' : page.slug}`}>
            {page.title}
          </option>
        ))}
      </datalist>
    </>
  );
}

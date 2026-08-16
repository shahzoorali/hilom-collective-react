/**
 * Header and footer menu editor.
 *
 * Saving replaces the whole menu, matching how the backend stores it — a
 * reorder changes most positions at once, so per-item saves would be both more
 * requests and more ways to end up half-applied.
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
    // Published pages populate the link picker, so an editor doesn't have to
    // remember or retype URLs.
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
      setNotice(`${menu.label} saved.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {menus.length === 0 && <p className="muted">No menus configured.</p>}

      {menus.map((menu) => (
        <div className="panel" style={{ marginBottom: '1.5rem' }} key={menu.key}>
          <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>{menu.label}</h2>

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
                  gap: '0.4rem',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginBottom: '0.5rem',
                }}
              >
                <input
                  placeholder="Label"
                  style={{ flex: '1 1 160px' }}
                  value={item.label}
                  onChange={(e) => replace({ label: e.target.value })}
                />
                <input
                  placeholder="/about or https://…"
                  style={{ flex: '1 1 200px' }}
                  value={item.href}
                  onChange={(e) => replace({ href: e.target.value })}
                  list="cms-page-slugs"
                />
                <select
                  value={item.target}
                  onChange={(e) => replace({ target: e.target.value as 'self' | 'blank' })}
                >
                  <option value="self">Same tab</option>
                  <option value="blank">New tab</option>
                </select>
                <label className="small" style={{ display: 'flex', gap: '0.3rem', margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={item.visible}
                    onChange={(e) => replace({ visible: e.target.checked })}
                  />
                  Visible
                </label>
                <button className="btn btn-ghost small" onClick={() => move(-1)}>↑</button>
                <button className="btn btn-ghost small" onClick={() => move(1)}>↓</button>
                <button
                  className="btn btn-ghost small"
                  onClick={() => patch(menu.key, menu.items.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.7rem' }}>
            <button className="btn btn-ghost small" onClick={() => patch(menu.key, [...menu.items, blank()])}>
              + Add link
            </button>
            <button className="btn btn-primary small" onClick={() => save(menu)} disabled={busy}>
              Save {menu.label}
            </button>
          </div>
        </div>
      ))}

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

/** Page list — create, open, publish state, delete. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminCreatePage, adminDeletePage, adminListPages, type AdminPage } from '../../lib/cms';

export default function PagesTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [pages, setPages] = useState<AdminPage[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      setPages(await adminListPages(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const page = await adminCreatePage(adminKey, { title: title.trim() });
      setTitle('');
      // The editor lives at its own URL — see PagesTab's route in Admin.tsx —
      // so opening a freshly created page is just a navigation, not a local
      // state flip.
      navigate(`/admin/pages/${page.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(page: AdminPage) {
    if (!window.confirm(`Delete "${page.title}"? This cannot be undone.`)) return;
    try {
      await adminDeletePage(adminKey, page.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>New page</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            style={{ flex: 1 }}
            placeholder="Page title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn btn-primary" onClick={create} disabled={busy || !title.trim()}>
            Create
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          The URL is taken from the title (“Our Team” → /our-team) and can be changed later. New
          pages start as drafts and are not reachable until published.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Pages</h2>
        {pages.length === 0 ? (
          <p className="muted">No pages yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th><th>URL</th><th>Status</th><th>Updated</th><th />
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.id}>
                    <td>
                      <strong>{page.title}</strong>
                      {page.is_system && (
                        <div className="small muted" title="Linked from the site's navigation or buttons">
                          built-in
                        </div>
                      )}
                    </td>
                    <td className="small mono">/{page.slug === 'home' ? '' : page.slug}</td>
                    <td>
                      <span className={page.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                        {page.status}
                      </span>
                    </td>
                    <td className="small">{new Date(page.updated_at).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary small" onClick={() => navigate(`/admin/pages/${page.id}`)}>
                        Edit
                      </button>
                      {!page.is_system && (
                        <button
                          className="btn btn-ghost small"
                          style={{ marginLeft: '0.35rem' }}
                          onClick={() => remove(page)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Pages tab — elevated dashboard view for managing CMS and system pages.
 *
 * Features stats overview cards, search & filter toolbar, system page badges,
 * quick navigation to the Puck editor, and one-click live previews.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminCreatePage, adminDeletePage, adminListPages, type AdminPage } from '../../lib/cms';

export default function PagesTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [pages, setPages] = useState<AdminPage[]>([]);
  const [title, setTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'system' | 'custom'>('all');
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
      navigate(`/admin/pages/${page.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(page: AdminPage) {
    if (!window.confirm(`Delete page "${page.title}"? This cannot be undone.`)) return;
    try {
      await adminDeletePage(adminKey, page.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Filtered pages
  const filteredPages = useMemo(() => {
    return pages.filter((p) => {
      const matchesSearch =
        !searchQuery.trim() ||
        p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.slug.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;

      const matchesType =
        typeFilter === 'all' ||
        (typeFilter === 'system' && p.is_system) ||
        (typeFilter === 'custom' && !p.is_system);

      return matchesSearch && matchesStatus && matchesType;
    });
  }, [pages, searchQuery, statusFilter, typeFilter]);

  // Stats
  const publishedCount = pages.filter((p) => p.status === 'published').length;
  const draftCount = pages.filter((p) => p.status === 'draft').length;
  const systemCount = pages.filter((p) => p.is_system).length;

  return (
    <>
      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {/* Stats Overview */}
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Total Pages</span>
          <span className="admin-stat-card__value">{pages.length}</span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Published</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--forest)' }}>
            {publishedCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Drafts</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--ochre-dark)' }}>
            {draftCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Built-in Pages</span>
          <span className="admin-stat-card__value">{systemCount}</span>
        </div>
      </div>

      {/* Create New Page Panel */}
      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Create New Page</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            style={{ flex: 1 }}
            placeholder="Page title (e.g. 'Our Philosophy', 'Workshops')"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && title.trim()) create();
            }}
          />
          <button className="btn btn-primary" onClick={create} disabled={busy || !title.trim()}>
            Create & Edit
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
          The URL slug is automatically derived from the title (“Our Philosophy” → /our-philosophy) and can be customized later in SEO settings.
        </p>
      </div>

      {/* Pages List & Filters */}
      <div className="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>All Pages ({filteredPages.length})</h2>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="admin-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="Search pages by title or slug…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'published' | 'draft')}
          >
            <option value="all">All Statuses</option>
            <option value="published">Published ({publishedCount})</option>
            <option value="draft">Drafts ({draftCount})</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'all' | 'system' | 'custom')}
          >
            <option value="all">All Page Types</option>
            <option value="system">Built-in Core Pages ({systemCount})</option>
            <option value="custom">Custom CMS Pages ({pages.length - systemCount})</option>
          </select>

          {(searchQuery || statusFilter !== 'all' || typeFilter !== 'all') && (
            <button
              className="btn btn-ghost small"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
                setTypeFilter('all');
              }}
            >
              Reset Filters
            </button>
          )}
        </div>

        {filteredPages.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <p className="muted">
              {pages.length === 0 ? 'No pages found.' : 'No pages match your search and filter criteria.'}
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>URL Route</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Last Updated</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPages.map((page) => {
                  const livePath = page.slug === 'home' ? '/' : `/${page.slug}`;
                  return (
                    <tr key={page.id}>
                      <td>
                        <strong style={{ fontSize: '0.95rem', display: 'block' }}>{page.title}</strong>
                      </td>
                      <td>
                        <span className="small mono muted">{livePath}</span>
                      </td>
                      <td>
                        {page.is_system ? (
                          <span
                            className="pill"
                            style={{ background: 'rgba(47, 94, 62, 0.08)', color: 'var(--forest)', fontSize: '0.75rem', fontWeight: 600 }}
                            title="Linked in core site navigation"
                          >
                            Built-in
                          </span>
                        ) : (
                          <span
                            className="pill"
                            style={{ background: 'var(--cream)', color: 'var(--ink-light)', fontSize: '0.75rem' }}
                          >
                            CMS Page
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={page.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                          {page.status}
                        </span>
                      </td>
                      <td className="small">{new Date(page.updated_at).toLocaleDateString()}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {page.status === 'published' && (
                          <a
                            href={livePath}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-ghost small"
                            style={{ marginRight: '0.35rem', textDecoration: 'none' }}
                            title="View live page"
                          >
                            View ↗
                          </a>
                        )}
                        <button
                          className="btn btn-primary small"
                          onClick={() => navigate(`/admin/pages/${page.id}`)}
                        >
                          Edit Canvas
                        </button>
                        {!page.is_system && (
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                            onClick={() => remove(page)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

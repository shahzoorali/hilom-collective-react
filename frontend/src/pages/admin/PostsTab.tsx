/**
 * Posts tab — elevated dashboard view for managing blog posts and categories.
 *
 * Features stats overview cards, search & filter toolbar, post cover thumbnail
 * previews, quick navigation to the Puck editor, and category management.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  adminCreatePost,
  adminDuplicatePost,
  adminListPosts,
  adminListTrashedPosts,
  adminPermanentlyDeletePost,
  adminTrashPost,
  adminUntrashPost,
  adminListCategories,
  adminCreateCategory,
  adminDeleteCategory,
  type AdminPost,
  type AdminCategory,
} from '../../lib/cms';
import ScheduledBadge from './ScheduledBadge';

export default function PostsTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [view, setView] = useState<'active' | 'trash'>('active');
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [trashed, setTrashed] = useState<AdminPost[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [title, setTitle] = useState('');
  const [catName, setCatName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'scheduled'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadPosts() {
    try {
      setPosts(await adminListPosts(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reloadTrash() {
    try {
      setTrashed(await adminListTrashedPosts(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reloadCategories() {
    try {
      setCategories(await adminListCategories(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reloadPosts();
    void reloadTrash();
    void reloadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  async function createPost() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const post = await adminCreatePost(adminKey, { title: title.trim() });
      setTitle('');
      navigate(`/admin/posts/${post.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function trashPost(post: AdminPost) {
    if (!window.confirm(`Move "${post.title}" to trash? You can restore it from Trash later.`)) return;
    setError(null);
    try {
      await adminTrashPost(adminKey, post.id);
      await reloadPosts();
      await reloadTrash();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function restorePost(post: AdminPost) {
    setError(null);
    try {
      await adminUntrashPost(adminKey, post.id);
      await reloadPosts();
      await reloadTrash();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function purgePost(post: AdminPost) {
    if (
      !window.confirm(
        `Permanently delete "${post.title}"? This cannot be undone — its revision history goes with it.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await adminPermanentlyDeletePost(adminKey, post.id);
      await reloadTrash();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function duplicatePost(post: AdminPost) {
    setError(null);
    setBusy(true);
    try {
      const copy = await adminDuplicatePost(adminKey, post.id);
      await reloadPosts();
      navigate(`/admin/posts/${copy.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createCategory() {
    if (!catName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await adminCreateCategory(adminKey, { name: catName.trim() });
      setCatName('');
      await reloadCategories();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeCategory(cat: AdminCategory) {
    if (!window.confirm(`Delete category "${cat.name}"? Posts in this category will become Uncategorized.`)) {
      return;
    }
    try {
      await adminDeleteCategory(adminKey, cat.id);
      await reloadCategories();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Filtered Posts computation
  const filteredPosts = useMemo(() => {
    return posts.filter((p) => {
      // Search
      const matchesSearch =
        !searchQuery.trim() ||
        p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

      // Status
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;

      // Category
      const matchesCategory =
        categoryFilter === 'all' ||
        (categoryFilter === 'none' && !p.category_id) ||
        p.category_id === categoryFilter;

      return matchesSearch && matchesStatus && matchesCategory;
    });
  }, [posts, searchQuery, statusFilter, categoryFilter]);

  // Stats
  const publishedCount = posts.filter((p) => p.status === 'published').length;
  const draftCount = posts.filter((p) => p.status === 'draft').length;
  const scheduledCount = posts.filter((p) => p.status === 'scheduled').length;

  return (
    <>
      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {/* Stats Overview */}
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Total Posts</span>
          <span className="admin-stat-card__value">{posts.length}</span>
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
          <span className="admin-stat-card__label">Categories</span>
          <span className="admin-stat-card__value">{categories.length}</span>
        </div>
      </div>

      {/* Active / Trash toggle */}
      <div className="admin-view-toggle">
        <button
          className={view === 'active' ? 'admin-view-toggle__btn is-active' : 'admin-view-toggle__btn'}
          onClick={() => setView('active')}
        >
          All Posts ({posts.length})
        </button>
        <button
          className={view === 'trash' ? 'admin-view-toggle__btn is-active' : 'admin-view-toggle__btn'}
          onClick={() => setView('trash')}
        >
          🗑 Trash ({trashed.length})
        </button>
      </div>

      {view === 'active' && (
        <>
          {/* Create New Post Panel */}
          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Create New Post</h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                style={{ flex: 1 }}
                placeholder="Enter post title (e.g. 'Mindful Breathing for Better Sleep')"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && title.trim()) createPost();
                }}
              />
              <button className="btn btn-primary" onClick={createPost} disabled={busy || !title.trim()}>
                Create & Edit
              </button>
            </div>
            <p className="small muted" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
              The URL slug is automatically generated from the title and can be customized anytime in Post Settings.
              New posts start as private drafts.
            </p>
          </div>

          {/* Posts List & Filters */}
          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1.15rem', margin: 0 }}>All Posts ({filteredPosts.length})</h2>
            </div>

            {/* Search & Filter Toolbar */}
            <div className="admin-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="Search posts by title, slug, or tag…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'published' | 'draft' | 'scheduled')}
              >
                <option value="all">All Statuses</option>
                <option value="published">Published ({publishedCount})</option>
                <option value="scheduled">Scheduled ({scheduledCount})</option>
                <option value="draft">Drafts ({draftCount})</option>
              </select>

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">All Categories</option>
                <option value="none">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              {(searchQuery || statusFilter !== 'all' || categoryFilter !== 'all') && (
                <button
                  className="btn btn-ghost small"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                    setCategoryFilter('all');
                  }}
                >
                  Reset Filters
                </button>
              )}
            </div>

            {filteredPosts.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}>
                <p className="muted" style={{ marginBottom: '0.5rem' }}>
                  {posts.length === 0 ? 'No blog posts created yet.' : 'No posts match your search and filter criteria.'}
                </p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 48 }}>Cover</th>
                      <th>Title & URL</th>
                      <th>Category</th>
                      <th>Author</th>
                      <th>Status</th>
                      <th>Last Updated</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPosts.map((post) => (
                      <tr key={post.id}>
                        <td>
                          {post.image_url ? (
                            <img
                              src={post.image_url}
                              alt=""
                              style={{ width: 44, height: 32, borderRadius: 4, objectFit: 'cover', display: 'block' }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 44,
                                height: 32,
                                borderRadius: 4,
                                background: 'var(--cream)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.7rem',
                                color: 'var(--muted)',
                              }}
                            >
                              —
                            </div>
                          )}
                        </td>
                        <td>
                          <strong style={{ fontSize: '0.95rem', display: 'block' }}>{post.title}</strong>
                          <span className="small mono muted">/blog/{post.slug}</span>
                        </td>
                        <td className="small">
                          {post.categories?.name ? (
                            <span className="pill" style={{ background: 'var(--cream)', color: 'var(--forest)', fontSize: '0.78rem' }}>
                              {post.categories.name}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="small">{post.author_name || <span className="muted">—</span>}</td>
                        <td>
                          {post.status === 'scheduled' ? (
                            <ScheduledBadge at={post.scheduled_at} />
                          ) : (
                            <span className={post.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                              {post.status}
                            </span>
                          )}
                        </td>
                        <td className="small">{new Date(post.updated_at).toLocaleDateString()}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {post.status === 'published' && (
                            <a
                              href={`/blog/${post.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-ghost small"
                              style={{ marginRight: '0.35rem', textDecoration: 'none' }}
                              title="View live post"
                            >
                              View ↗
                            </a>
                          )}
                          <button
                            className="btn btn-primary small"
                            onClick={() => navigate(`/admin/posts/${post.id}`)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem' }}
                            onClick={() => duplicatePost(post)}
                            disabled={busy}
                            title="Duplicate this post as a new draft"
                          >
                            Duplicate
                          </button>
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                            onClick={() => trashPost(post)}
                            title="Move to trash"
                          >
                            Trash
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {view === 'trash' && (
        <div className="panel" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Trash ({trashed.length})</h2>
          <p className="small muted">
            Trashed posts are hidden from the blog and from the main list, but not gone — restore them
            or permanently delete them here.
          </p>

          {trashed.length === 0 ? (
            <p className="muted" style={{ marginTop: '1rem' }}>Trash is empty.</p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Title & URL</th>
                    <th>Was</th>
                    <th>Trashed</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {trashed.map((post) => (
                    <tr key={post.id}>
                      <td>
                        <strong style={{ fontSize: '0.95rem', display: 'block' }}>{post.title}</strong>
                        <span className="small mono muted">/blog/{post.slug}</span>
                      </td>
                      <td className="small muted">{post.previous_status ?? 'draft'}</td>
                      <td className="small">
                        {post.deleted_at ? new Date(post.deleted_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost small" onClick={() => restorePost(post)}>
                          Restore
                        </button>
                        <button
                          className="btn btn-ghost small"
                          style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                          onClick={() => purgePost(post)}
                        >
                          Delete Permanently
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Categories Management Panel */}
      <div className="panel">
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Manage Categories ({categories.length})</h2>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', maxWidth: 500 }}>
          <input
            style={{ flex: 1 }}
            placeholder="New category name (e.g. Wellness, Mindfulness)"
            value={catName}
            onChange={(e) => setCatName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && catName.trim()) createCategory();
            }}
          />
          <button className="btn btn-primary small" onClick={createCategory} disabled={busy || !catName.trim()}>
            Add Category
          </button>
        </div>

        {categories.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>No categories created yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {categories.map((cat) => {
              const count = posts.filter((p) => p.category_id === cat.id).length;
              return (
                <span
                  key={cat.id}
                  className="pill"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    padding: '0.35rem 0.75rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <strong>{cat.name}</strong>
                  <span className="small muted" style={{ fontSize: '0.78rem' }}>({count})</span>
                  <button
                    onClick={() => removeCategory(cat)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      color: 'inherit',
                      fontSize: '1rem',
                      opacity: 0.6,
                    }}
                    title="Delete category"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

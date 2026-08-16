/** Post list — create, open, publish state, delete. Follows PagesTab pattern. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  adminCreatePost,
  adminDeletePost,
  adminListPosts,
  adminListCategories,
  adminCreateCategory,
  adminDeleteCategory,
  type AdminPost,
  type AdminCategory,
} from '../../lib/cms';

export default function PostsTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [title, setTitle] = useState('');
  const [catName, setCatName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadPosts() {
    try {
      setPosts(await adminListPosts(adminKey));
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

  async function removePost(post: AdminPost) {
    if (!window.confirm(`Delete "${post.title}"? This cannot be undone.`)) return;
    try {
      await adminDeletePost(adminKey, post.id);
      await reloadPosts();
    } catch (e) {
      setError((e as Error).message);
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
    if (!window.confirm(`Delete category "${cat.name}"? Posts in this category will lose their category.`)) return;
    try {
      await adminDeleteCategory(adminKey, cat.id);
      await reloadCategories();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>New post</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            style={{ flex: 1 }}
            placeholder="Post title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn btn-primary" onClick={createPost} disabled={busy || !title.trim()}>
            Create
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          The URL is taken from the title ("My First Post" → /blog/my-first-post). New
          posts start as drafts and are not visible until published.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Posts</h2>
        {posts.length === 0 ? (
          <p className="muted">No posts yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th><th>URL</th><th>Category</th><th>Status</th><th>Updated</th><th />
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => (
                  <tr key={post.id}>
                    <td><strong>{post.title}</strong></td>
                    <td className="small mono">/blog/{post.slug}</td>
                    <td className="small">{post.categories?.name ?? '—'}</td>
                    <td>
                      <span className={post.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                        {post.status}
                      </span>
                    </td>
                    <td className="small">{new Date(post.updated_at).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary small" onClick={() => navigate(`/admin/posts/${post.id}`)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-ghost small"
                        style={{ marginLeft: '0.35rem' }}
                        onClick={() => removePost(post)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Categories management */}
      <div className="panel">
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Categories</h2>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            style={{ flex: 1 }}
            placeholder="Category name"
            value={catName}
            onChange={(e) => setCatName(e.target.value)}
          />
          <button className="btn btn-primary small" onClick={createCategory} disabled={busy || !catName.trim()}>
            Add
          </button>
        </div>
        {categories.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>No categories yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {categories.map((cat) => (
              <span key={cat.id} className="pill" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                {cat.name}
                <button
                  onClick={() => removeCategory(cat)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', fontSize: '0.9em' }}
                  title="Delete category"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

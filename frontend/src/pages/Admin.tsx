import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { adminListPages } from '../lib/cms';
import hilomLogo from '../assets/hilom-logo.png';
import CommerceTab from './admin/CommerceTab';
import FacilitatorsTab from './admin/FacilitatorsTab';
import PayoutsTab from './admin/PayoutsTab';
import PagesTab from './admin/PagesTab';
import PageEditor from './admin/PageEditor';
import MenusTab from './admin/MenusTab';
import FormsTab from './admin/FormsTab';
import EventsTab from './admin/EventsTab';
import PostsTab from './admin/PostsTab';
import PostEditor from './admin/PostEditor';
import { MediaGrid } from './admin/MediaLibrary';

const KEY_STORAGE = 'hilom.adminKey';

const TABS = [
  { label: 'Pages', path: 'pages', icon: '📄' },
  { label: 'Posts', path: 'posts', icon: '✍️' },
  { label: 'Events', path: 'events', icon: '📅' },
  { label: 'Media', path: 'media', icon: '🖼️' },
  { label: 'Menus', path: 'menus', icon: '🧭' },
  { label: 'Forms', path: 'forms', icon: '📋' },
  { label: 'Commerce', path: 'commerce', icon: '💳' },
  { label: 'Facilitators', path: 'facilitators', icon: '🌿' },
  { label: 'Payouts', path: 'payouts', icon: '🏦' },
] as const;

function PageEditorRoute({ adminKey }: { adminKey: string }) {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  if (!pageId) return <Navigate to="/admin/pages" replace />;
  return <PageEditor adminKey={adminKey} pageId={pageId} onBack={() => navigate('/admin/pages')} />;
}

function PostEditorRoute({ adminKey }: { adminKey: string }) {
  const { postId } = useParams<{ postId: string }>();
  const navigate = useNavigate();
  if (!postId) return <Navigate to="/admin/posts" replace />;
  return <PostEditor adminKey={adminKey} postId={postId} onBack={() => navigate('/admin/posts')} />;
}

export default function Admin() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(() => Boolean(sessionStorage.getItem(KEY_STORAGE)));

  const location = useLocation();
  const navigate = useNavigate();

  async function signIn(key: string) {
    setBusy(true);
    setError(null);
    try {
      await adminListPages(key);
      sessionStorage.setItem(KEY_STORAGE, key);
      setAuthed(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const stored = sessionStorage.getItem(KEY_STORAGE);
    if (!stored) return;
    signIn(stored).finally(() => setCheckingSession(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function signOut() {
    sessionStorage.removeItem(KEY_STORAGE);
    setAuthed(false);
    setAdminKey('');
    navigate('/admin/pages');
  }

  if (checkingSession) {
    return (
      <div className="admin-auth-page">
        <div style={{ textAlign: 'center' }}>
          <img src={hilomLogo} alt="Hilom Collective" className="admin-auth-logo" />
          <p className="muted">Verifying admin session…</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="admin-auth-page">
        <div className="admin-auth-card">
          <div className="admin-auth-header">
            <img src={hilomLogo} alt="Hilom Collective" className="admin-auth-logo" />
            <h1 className="admin-auth-title">Admin Portal</h1>
            <p className="admin-auth-subtitle">Sign in to manage content, events, and commerce</p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void signIn(adminKey);
            }}
          >
            {error && <div className="alert alert-error" style={{ marginBottom: '1.25rem' }}>{error}</div>}

            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="key" style={{ fontWeight: 600 }}>Admin Access Key</label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  id="key"
                  type={showPassword ? 'text' : 'password'}
                  value={adminKey}
                  autoComplete="current-password"
                  placeholder="Enter secret key…"
                  onChange={(e) => setAdminKey(e.target.value)}
                  style={{ paddingRight: '2.5rem' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  style={{
                    position: 'absolute',
                    right: '0.75rem',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--muted)',
                    padding: 0,
                  }}
                  title={showPassword ? 'Hide key' : 'Show key'}
                >
                  {showPassword ? '👁️' : '🔒'}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={busy || !adminKey.trim()}
              style={{ padding: '0.75rem 1rem', fontSize: '0.95rem' }}
            >
              {busy ? 'Verifying access…' : 'Sign in to Dashboard'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeTab = location.pathname.split('/')[2] ?? 'pages';
  const editingPage = /^\/admin\/pages\/[^/]+/.test(location.pathname);
  const editingPost = /^\/admin\/posts\/[^/]+/.test(location.pathname);
  const flushChrome = editingPage || editingPost;

  return (
    <div className="admin-shell">
      {/* Elevated Admin Topbar */}
      <header className="admin-topbar">
        <Link to="/admin/pages" className="admin-topbar-brand">
          <img src={hilomLogo} alt="Hilom" className="brand-logo" />
          <div className="admin-brand-text">
            <span className="admin-brand-title">Hilom CMS</span>
            <span className="admin-brand-badge">Production Live</span>
          </div>
        </Link>

        <nav className="admin-tabs" aria-label="Admin Navigation">
          {TABS.map((t) => {
            const isActive = activeTab === t.path;
            return (
              <button
                key={t.path}
                className={`admin-tab-btn ${isActive ? 'admin-tab-btn--active' : ''}`}
                onClick={() => navigate(`/admin/${t.path}`)}
              >
                <span>{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="admin-topbar-actions">
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="admin-view-site-link"
            title="Open website in new tab"
          >
            <span>🌐</span>
            <span>View Site ↗</span>
          </a>
          <button
            className="btn btn-ghost small"
            onClick={signOut}
            title="Sign out of admin"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
          >
            <span>🚪</span>
            <span>Sign out</span>
          </button>
        </div>
      </header>

      {/* Main Admin Body */}
      <main className={flushChrome ? 'admin-content admin-content--flush' : 'admin-content'}>
        <Routes>
          <Route index element={<Navigate to="pages" replace />} />
          <Route path="pages" element={<PagesTab adminKey={adminKey} />} />
          <Route path="pages/:pageId" element={<PageEditorRoute adminKey={adminKey} />} />
          <Route path="posts" element={<PostsTab adminKey={adminKey} />} />
          <Route path="posts/:postId" element={<PostEditorRoute adminKey={adminKey} />} />
          <Route path="events" element={<EventsTab adminKey={adminKey} />} />
          <Route
            path="media"
            element={
              <div className="panel">
                <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Media Library</h2>
                <p className="small muted" style={{ marginTop: '-0.25rem', marginBottom: '1.25rem' }}>
                  Upload and manage imagery for pages, blog posts, and event listings. Files are stored securely on AWS S3 and served via CloudFront CDN.
                </p>
                <MediaGrid adminKey={adminKey} />
              </div>
            }
          />
          <Route path="menus" element={<MenusTab adminKey={adminKey} />} />
          <Route path="forms" element={<FormsTab adminKey={adminKey} />} />
          <Route path="commerce" element={<CommerceTab adminKey={adminKey} />} />
          <Route path="facilitators" element={<FacilitatorsTab adminKey={adminKey} />} />
          <Route path="payouts" element={<PayoutsTab adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="pages" replace />} />
        </Routes>
      </main>
    </div>
  );
}

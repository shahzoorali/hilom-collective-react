import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { adminListPages, ADMIN_ACTOR_STORAGE } from '../lib/cms';
import hilomLogo from '../assets/hilom-logo.png';
import CommerceTab from './admin/CommerceTab';
import FacilitatorsTab from './admin/FacilitatorsTab';
import PayoutsTab from './admin/PayoutsTab';
import BookingsTab from './admin/BookingsTab';
import PagesTab from './admin/PagesTab';
import PageEditor from './admin/PageEditor';
import MenusTab from './admin/MenusTab';
import FormsTab from './admin/FormsTab';
import EventsTab from './admin/EventsTab';
import RegistrationsTab from './admin/RegistrationsTab';
import PostsTab from './admin/PostsTab';
import PostEditor from './admin/PostEditor';
import { MediaGrid } from './admin/MediaLibrary';

const KEY_STORAGE = 'hilom.adminKey';

const NAV_GROUPS = [
  {
    label: 'Content',
    items: [
      { label: 'Pages', path: 'pages', icon: '📄' },
      { label: 'Posts', path: 'posts', icon: '✍️' },
      { label: 'Events', path: 'events', icon: '📅' },
      { label: 'Media', path: 'media', icon: '🖼️' },
      { label: 'Menus', path: 'menus', icon: '🧭' },
    ],
  },
  {
    label: 'Engagement',
    items: [
      { label: 'Forms', path: 'forms', icon: '📋' },
      { label: 'Bookings', path: 'bookings', icon: '🗓️' },
      { label: 'Registrations', path: 'registrations', icon: '🎟️' },
      { label: 'Facilitators', path: 'facilitators', icon: '🌿' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { label: 'Commerce', path: 'commerce', icon: '💳' },
      { label: 'Payouts', path: 'payouts', icon: '🏦' },
    ],
  },
] as const;

const TABS = NAV_GROUPS.flatMap((g) => g.items);

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
  // Recorded against money-affecting actions in the audit log. The key is
  // shared, so this is an attestation rather than proof of who acted — the
  // labels below say so, because a name that looks like authentication and is
  // not is worse than no name at all.
  const [actor, setActor] = useState(() => sessionStorage.getItem(ADMIN_ACTOR_STORAGE) ?? '');
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
    sessionStorage.removeItem(ADMIN_ACTOR_STORAGE);
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

            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="actor" style={{ fontWeight: 600 }}>Your name</label>
              <input
                id="actor"
                value={actor}
                autoComplete="name"
                placeholder="e.g. Rina"
                onChange={(e) => {
                  setActor(e.target.value);
                  sessionStorage.setItem(ADMIN_ACTOR_STORAGE, e.target.value);
                }}
              />
              <span className="small muted">
                Recorded next to anything you do that moves money, so the ledger reads
                “Rina marked this paid” instead of “someone did”. This key is shared, so it is a label
                you are choosing — not a login.
              </span>
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
    <div className="admin-shell admin-shell--sidebar">
      {/* Left Sidebar Navigation */}
      <aside className="admin-sidebar">
        <Link to="/admin/pages" className="admin-sidebar-brand">
          <img src={hilomLogo} alt="Hilom" className="brand-logo" />
          <div className="admin-brand-text">
            <span className="admin-brand-title">Hilom CMS</span>
            <span className="admin-brand-badge">Production Live</span>
          </div>
        </Link>

        <nav className="admin-sidebar-nav" aria-label="Admin Navigation">
          {NAV_GROUPS.map((group) => (
            <div className="admin-sidebar-group" key={group.label}>
              <div className="admin-sidebar-group-label">{group.label}</div>
              {group.items.map((t) => {
                const isActive = activeTab === t.path;
                return (
                  <button
                    key={t.path}
                    className={`admin-sidebar-btn ${isActive ? 'admin-sidebar-btn--active' : ''}`}
                    onClick={() => navigate(`/admin/${t.path}`)}
                  >
                    <span>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="admin-sidebar-actions">
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'center' }}
          >
            <span>🚪</span>
            <span>Sign out</span>
          </button>
        </div>
      </aside>

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
          <Route path="bookings" element={<BookingsTab adminKey={adminKey} />} />
          <Route path="registrations" element={<RegistrationsTab adminKey={adminKey} />} />
          <Route path="payouts" element={<PayoutsTab adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="pages" replace />} />
        </Routes>
      </main>
    </div>
  );
}

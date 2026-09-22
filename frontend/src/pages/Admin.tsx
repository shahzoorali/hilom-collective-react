import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { adminListPages, ADMIN_ACTOR_STORAGE } from '../lib/cms';
import hilomLogo from '../assets/hilom-logo.png';
import DashboardTab from './admin/DashboardTab';
import AuditLogTab from './admin/AuditLogTab';
import OrdersTab from './admin/OrdersTab';
import ProductsTab from './admin/ProductsTab';
import ClassesTab from './admin/ClassesTab';
import SettingsTab from './admin/SettingsTab';
import PromoCodesTab from './admin/PromoCodesTab';
import FacilitatorsTab from './admin/FacilitatorsTab';
import FacilitatorEditor from './admin/FacilitatorEditor';
import PayoutsTab from './admin/PayoutsTab';
import ReviewsTab from './admin/ReviewsTab';
import BookingsTab from './admin/BookingsTab';
import PagesTab from './admin/PagesTab';
import PageEditor from './admin/PageEditor';
import FormsTab from './admin/FormsTab';
import EventsTab from './admin/EventsTab';
import RegistrationsTab from './admin/RegistrationsTab';
import PeopleTab from './admin/PeopleTab';
import CognitoUsersTab from './admin/CognitoUsersTab';
import { MOODLE_URL } from '../config';
import PostsTab from './admin/PostsTab';
import PostEditor from './admin/PostEditor';
import KnowledgeBaseTab from './admin/KnowledgeBaseTab';
import KbArticleEditor from './admin/KbArticleEditor';
import { MediaGrid } from './admin/MediaLibrary';

const KEY_STORAGE = 'hilom.adminKey';

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', path: 'dashboard', icon: '🏠' }],
  },
  {
    label: 'Content',
    items: [
      { label: 'Pages', path: 'pages', icon: '📄' },
      { label: 'Posts', path: 'posts', icon: '✍️' },
      { label: 'Events', path: 'events', icon: '📅' },
      // Not in the plan's Content row verbatim, but placed here deliberately:
      // §6 names Reviews and the event proposal queue as "both moderation
      // queues [that] live nowhere near each other", and the proposal queue
      // is a filter on Events, right above. Filing Reviews under People
      // (where Facilitators sits) would repeat the exact problem being fixed.
      { label: 'Reviews', path: 'reviews', icon: '⭐' },
      { label: 'Help Centre', path: 'knowledge-base', icon: '💡' },
      { label: 'Media', path: 'media', icon: '🖼️' },
    ],
  },
  {
    label: 'People',
    items: [
      // Last in its old group because it is the read across the ones above
      // it — kept first here since Accounts and Facilitators are its own
      // raw sources, not siblings of it.
      { label: 'People', path: 'people', icon: '👥' },
      // People derived from transactions; Accounts is the raw Cognito pool,
      // including sign-ups that have never transacted.
      { label: 'Accounts', path: 'accounts', icon: '🔑' },
      { label: 'Facilitators', path: 'facilitators', icon: '🌿' },
      { label: 'Forms', path: 'forms', icon: '📋' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { label: 'Orders', path: 'orders', icon: '💳' },
      { label: 'Products & Courses', path: 'products', icon: '📦' },
      { label: 'Bookings', path: 'bookings', icon: '🗓️' },
      { label: 'Registrations', path: 'registrations', icon: '🎟️' },
      { label: 'Classes', path: 'classes', icon: '🧘' },
      { label: 'Promo Codes', path: 'promo-codes', icon: '🏷️' },
      { label: 'Payouts', path: 'payouts', icon: '🏦' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', path: 'settings', icon: '⚙️' },
      { label: 'Audit Log', path: 'audit-log', icon: '📜' },
    ],
  },
] as const;

function CommerceRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/admin/orders${search}`} replace />;
}

/** `/admin/menus` and `/admin/footer` -> Settings, on the section that used to be their own screen. */
function SettingsRedirect({ section }: { section: 'menus' | 'footer' }) {
  return <Navigate to={`/admin/settings?section=${section}`} replace />;
}

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

function KbArticleEditorRoute({ adminKey }: { adminKey: string }) {
  const { articleId } = useParams<{ articleId: string }>();
  const navigate = useNavigate();
  if (!articleId) return <Navigate to="/admin/knowledge-base" replace />;
  return (
    <KbArticleEditor
      adminKey={adminKey}
      articleId={articleId}
      onBack={() => navigate('/admin/knowledge-base')}
    />
  );
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

  const [drawerOpen, setDrawerOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();

  // Close the mobile drawer on every navigation so tapping a section link
  // doesn't leave the menu covering the page it just opened.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

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
    navigate('/admin/dashboard');
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

  const activeTab = location.pathname.split('/')[2] ?? 'dashboard';
  const editingPage = /^\/admin\/pages\/[^/]+/.test(location.pathname);
  const editingPost = /^\/admin\/posts\/[^/]+/.test(location.pathname);
  const flushChrome = editingPage || editingPost;
  const activeLabel =
    NAV_GROUPS.map((g) => g.items.find((t) => t.path === activeTab)).find(Boolean)?.label ?? 'Admin';

  return (
    <div className="admin-shell admin-shell--sidebar">
      {/* Mobile-only top bar: hamburger + current section, sidebar becomes a slide-in drawer */}
      <header className="admin-mobile-topbar">
        <button
          type="button"
          className="admin-mobile-menu-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
        >
          ☰
        </button>
        <span className="admin-mobile-topbar-title">{activeLabel}</span>
        <img src={hilomLogo} alt="" className="admin-mobile-topbar-logo" />
      </header>

      {drawerOpen && (
        <div className="admin-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      {/* Left Sidebar Navigation (slides in as a drawer on mobile) */}
      <aside className={`admin-sidebar ${drawerOpen ? 'admin-sidebar--open' : ''}`}>
        <Link to="/admin/dashboard" className="admin-sidebar-brand">
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
          {/* Moodle's login page auto-redirects to Cognito SSO; ?nosso=1 is the
              bypass that reaches the password form for the admin/manual account. */}
          <a
            href={`${MOODLE_URL}/login/index.php?nosso=1`}
            target="_blank"
            rel="noreferrer"
            className="admin-view-site-link"
            title="Open the Moodle password login (bypasses SSO)"
          >
            <span>🎓</span>
            <span>Moodle staff login ↗</span>
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
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardTab adminKey={adminKey} />} />
          <Route path="pages" element={<PagesTab adminKey={adminKey} />} />
          <Route path="pages/:pageId" element={<PageEditorRoute adminKey={adminKey} />} />
          <Route path="posts" element={<PostsTab adminKey={adminKey} />} />
          <Route path="posts/:postId" element={<PostEditorRoute adminKey={adminKey} />} />
          <Route path="knowledge-base" element={<KnowledgeBaseTab adminKey={adminKey} />} />
          <Route
            path="knowledge-base/:articleId"
            element={<KbArticleEditorRoute adminKey={adminKey} />}
          />
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
          {/* Menus and Footer moved under Settings (§6) — old bookmarks land on
              the same screen they always did, just through the redirect. */}
          <Route path="menus" element={<SettingsRedirect section="menus" />} />
          <Route path="footer" element={<SettingsRedirect section="footer" />} />
          <Route path="settings" element={<SettingsTab adminKey={adminKey} />} />
          <Route path="forms" element={<FormsTab adminKey={adminKey} />} />
          <Route path="orders" element={<OrdersTab adminKey={adminKey} />} />
          <Route path="products" element={<ProductsTab adminKey={adminKey} />} />
          <Route path="classes" element={<ClassesTab adminKey={adminKey} />} />
          {/* Commerce was split in two. `/admin/commerce` is somebody's pinned
              tab, so it keeps working: it lands on the ledger, query intact
              (the dashboard's old `?stuck=1` still selects the Stuck filter). */}
          <Route path="commerce" element={<CommerceRedirect />} />
          <Route path="promo-codes" element={<PromoCodesTab adminKey={adminKey} />} />
          <Route path="facilitators" element={<FacilitatorsTab adminKey={adminKey} />} />
          <Route
            path="facilitators/:facilitatorId"
            element={<FacilitatorEditor adminKey={adminKey} />}
          />
          <Route path="bookings" element={<BookingsTab adminKey={adminKey} />} />
          <Route path="registrations" element={<RegistrationsTab adminKey={adminKey} />} />
          <Route path="people" element={<PeopleTab adminKey={adminKey} />} />
          <Route path="accounts" element={<CognitoUsersTab adminKey={adminKey} />} />
          <Route path="reviews" element={<ReviewsTab adminKey={adminKey} />} />
          <Route path="payouts" element={<PayoutsTab adminKey={adminKey} />} />
          <Route path="audit-log" element={<AuditLogTab adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { adminListPages } from '../lib/cms';
import hilomLogo from '../assets/hilom-logo.png';
import CommerceTab from './admin/CommerceTab';
import PagesTab from './admin/PagesTab';
import PageEditor from './admin/PageEditor';
import MenusTab from './admin/MenusTab';
import FormsTab from './admin/FormsTab';
import EventsTab from './admin/EventsTab';
import PostsTab from './admin/PostsTab';
import PostEditor from './admin/PostEditor';
import { MediaGrid } from './admin/MediaLibrary';

/**
 * Admin shell: its own topbar and tabs, deliberately not the public site's
 * <Layout> — see the note in App.tsx on why /admin/* is routed outside it.
 *
 * Auth is the shared admin key, entered here and kept in sessionStorage only —
 * it is never written to localStorage or a cookie, so it dies with the tab.
 * This is a deliberate stopgap: the plan moves /admin/* behind a Cognito admin
 * group, at which point this key input goes away entirely.
 */

const KEY_STORAGE = 'hilom.adminKey';

/** path segment under /admin, not just a display label — this is what makes
 *  the URL reflect which tab (and, for Pages, which page) is open. */
const TABS = [
  { label: 'Pages', path: 'pages' },
  { label: 'Posts', path: 'posts' },
  { label: 'Events', path: 'events' },
  { label: 'Media', path: 'media' },
  { label: 'Menus', path: 'menus' },
  { label: 'Forms', path: 'forms' },
  { label: 'Commerce', path: 'commerce' },
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
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True only while re-verifying a key already in sessionStorage, e.g. after a
  // hard refresh. `authed` itself always starts false — component state does
  // not survive a reload — so without this the sign-in form flashed on every
  // refresh even though the key was sitting right there, valid, doing nothing
  // until someone clicked "Sign in" again.
  const [checkingSession, setCheckingSession] = useState(() => Boolean(sessionStorage.getItem(KEY_STORAGE)));

  const location = useLocation();
  const navigate = useNavigate();

  /** "Signed in" means a real admin request succeeded — there is no separate
   *  login endpoint, so the cheapest admin GET is the check. */
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
    // Runs once, against whatever was in storage at mount — signIn itself
    // handles the outcome (setAuthed / setError). Deep-linking works for free
    // here: we never touch the URL, so a bookmarked /admin/pages/{id} is still
    // wherever this effect resolves signed-in TO, not redirected away from.
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
      <div className="admin-shell">
        <section className="section">
          <div className="container" style={{ maxWidth: 420 }}>
            <p className="muted">Signing in…</p>
          </div>
        </section>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="admin-shell">
        <section className="section">
          <div className="container" style={{ maxWidth: 420 }}>
            <h1>Admin</h1>
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                void signIn(adminKey);
              }}
            >
              {error && <div className="alert alert-error">{error}</div>}
              <div className="field">
                <label htmlFor="key">Admin key</label>
                <input
                  id="key" type="password" value={adminKey} autoComplete="off"
                  onChange={(e) => setAdminKey(e.target.value)}
                />
              </div>
              <button className="btn btn-primary btn-block" disabled={busy || !adminKey}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
            </form>
          </div>
        </section>
      </div>
    );
  }

  // Which top-level tab is active, derived from the URL rather than tracked
  // separately — /admin/pages/{id} still highlights "Pages". Flush chrome
  // (no padding) only while the page editor itself is on screen, so Puck gets
  // the full viewport the way its own demos look.
  const activeTab = location.pathname.split('/')[2] ?? 'pages';
  const editingPage = /^\/admin\/pages\/[^/]+/.test(location.pathname);
  const editingPost = /^\/admin\/posts\/[^/]+/.test(location.pathname);
  const flushChrome = editingPage || editingPost;

  return (
    <div className="admin-shell">
      <div className="admin-topbar">
        <img src={hilomLogo} alt="" className="brand-logo" />
        <h1>Admin</h1>
        <div className="admin-tabs">
          {TABS.map((t) => (
            <button
              key={t.path}
              className={activeTab === t.path ? 'btn btn-primary small' : 'btn btn-ghost small'}
              onClick={() => navigate(`/admin/${t.path}`)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost small" onClick={signOut}>
          Sign out
        </button>
      </div>

      <div className={flushChrome ? 'admin-content admin-content--flush' : 'admin-content'}>
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
                <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Media library</h2>
                <MediaGrid adminKey={adminKey} />
              </div>
            }
          />
          <Route path="menus" element={<MenusTab adminKey={adminKey} />} />
          <Route path="forms" element={<FormsTab adminKey={adminKey} />} />
          <Route path="commerce" element={<CommerceTab adminKey={adminKey} />} />
          <Route path="*" element={<Navigate to="pages" replace />} />
        </Routes>
      </div>
    </div>
  );
}

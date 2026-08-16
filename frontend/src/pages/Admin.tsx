import { useState } from 'react';
import { adminListPages } from '../lib/cms';
import hilomLogo from '../assets/hilom-logo.png';
import CommerceTab from './admin/CommerceTab';
import PagesTab from './admin/PagesTab';
import MenusTab from './admin/MenusTab';
import FormsTab from './admin/FormsTab';
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

const TABS = ['Pages', 'Media', 'Menus', 'Forms', 'Commerce'] as const;
type Tab = (typeof TABS)[number];

export default function Admin() {
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>('Pages');
  const [editingPage, setEditingPage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  function signOut() {
    sessionStorage.removeItem(KEY_STORAGE);
    setAuthed(false);
    setAdminKey('');
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

  return (
    <div className="admin-shell">
      <div className="admin-topbar">
        <img src={hilomLogo} alt="" className="brand-logo" />
        <h1>Admin</h1>
        <div className="admin-tabs">
          {TABS.map((name) => (
            <button
              key={name}
              className={name === tab ? 'btn btn-primary small' : 'btn btn-ghost small'}
              onClick={() => {
                setTab(name);
                setEditingPage(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost small" onClick={signOut}>
          Sign out
        </button>
      </div>

      {/* The page editor is flush (no padding) so Puck owns the full viewport
          below the topbar; every other tab keeps a readable, padded measure. */}
      <div className={tab === 'Pages' && editingPage ? 'admin-content admin-content--flush' : 'admin-content'}>
        {tab === 'Pages' && <PagesTab adminKey={adminKey} onEditingChange={setEditingPage} />}
        {tab === 'Media' && (
          <div className="panel">
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Media library</h2>
            <MediaGrid adminKey={adminKey} />
          </div>
        )}
        {tab === 'Menus' && <MenusTab adminKey={adminKey} />}
        {tab === 'Forms' && <FormsTab adminKey={adminKey} />}
        {tab === 'Commerce' && <CommerceTab adminKey={adminKey} />}
      </div>
    </div>
  );
}

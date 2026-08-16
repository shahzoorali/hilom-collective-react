import { useState } from 'react';
import { adminListPages } from '../lib/cms';
import CommerceTab from './admin/CommerceTab';
import PagesTab from './admin/PagesTab';
import MenusTab from './admin/MenusTab';
import FormsTab from './admin/FormsTab';
import { MediaGrid } from './admin/MediaLibrary';

/**
 * Admin shell: key gate plus tabs.
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

  if (!authed) {
    return (
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
    );
  }

  return (
    <section className="section">
      <div className="container">
        <h1>Admin</h1>

        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1.2rem' }}>
          {TABS.map((name) => (
            <button
              key={name}
              className={name === tab ? 'btn btn-primary small' : 'btn btn-ghost small'}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>

        {tab === 'Pages' && <PagesTab adminKey={adminKey} />}
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
    </section>
  );
}

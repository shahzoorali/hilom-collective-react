import { useSearchParams } from 'react-router-dom';
import MenusTab from './MenusTab';
import FooterTab from './FooterTab';
import { adminToast } from './ui/feedback';

/**
 * Admin → Settings (docs/admin-dashboard-plan.md §6).
 *
 * `site_settings` (0043) is a general key/value store for site-wide
 * configuration and has held exactly one key, `footer`, since it was built —
 * reachable only by opening the Footer screen, which was filed under Content
 * alongside Pages and Posts even though it configures the whole site rather
 * than a piece of content. Menus had the same problem. Neither screen changed
 * here; this page is the home they were missing, so the day a second setting
 * exists (a contact address, an analytics id, a maintenance flag) there is
 * somewhere for it to go instead of a screen of its own bearing no relation to
 * the others.
 *
 * `?section=` picks which one shows, so `/admin/menus` and `/admin/footer` —
 * years-old bookmarks — can redirect here without landing on a blank General
 * page (see the redirects in Admin.tsx).
 */
const SECTIONS = [
  { key: '', label: 'General' },
  { key: 'menus', label: 'Menus' },
  { key: 'footer', label: 'Footer' },
] as const;

export default function SettingsTab({ adminKey }: { adminKey: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get('section') ?? '';

  return (
    <div>
      <div className="panel" style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0, marginBottom: '0.25rem' }}>Settings</h2>
        <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
          Site-wide configuration — not tied to any one page or post.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={section === s.key ? 'btn btn-primary small' : 'btn btn-ghost small'}
              onClick={() => setSearchParams(s.key ? { section: s.key } : {}, { replace: true })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {section === '' && (
        <div className="stack">
          <div className="stat-grid" style={{ marginBottom: 0 }}>
            <button type="button" className="stat" onClick={() => setSearchParams({ section: 'menus' }, { replace: true })}>
              <span className="stat__label">Menus</span>
              <span style={{ fontWeight: 600 }}>Header and footer navigation</span>
              <span className="stat__hint">Links, order, new-tab and button styles, with broken-link checks.</span>
            </button>
            <button type="button" className="stat" onClick={() => setSearchParams({ section: 'footer' }, { replace: true })}>
              <span className="stat__label">Footer</span>
              <span style={{ fontWeight: 600 }}>Site-wide footer content</span>
              <span className="stat__hint">Columns, contact details and social links on every page.</span>
            </button>
          </div>

          <div className="panel">
            <h3 style={{ fontSize: '1rem', marginTop: 0 }}>This browser</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              Preferences kept only on this device — theme (toggle in the sidebar), saved table views,
              column choices and form read-state.
            </p>
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => {
                try {
                  Object.keys(localStorage)
                    .filter((k) => k.startsWith('hilom.admin.'))
                    .forEach((k) => localStorage.removeItem(k));
                  adminToast.success('Admin preferences reset on this browser');
                } catch {
                  adminToast.error('Browser storage is unavailable');
                }
              }}
            >
              Reset saved views and column choices
            </button>
          </div>

          <p className="small muted" style={{ margin: 0 }}>
            Menus and Footer are backed by <code>site_settings</code>, a general key/value store — the next
            site-wide setting belongs here as a new section, not a new screen.
          </p>
        </div>
      )}

      {section === 'menus' && <MenusTab adminKey={adminKey} />}
      {section === 'footer' && <FooterTab adminKey={adminKey} />}
    </div>
  );
}

import { useSearchParams } from 'react-router-dom';
import MenusTab from './MenusTab';
import FooterTab from './FooterTab';

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
        <div className="panel">
          <p style={{ marginTop: 0 }}>
            <strong>Menus</strong> and <strong>Footer</strong> live here, under Settings, because
            both edit something that shows on every page rather than one piece of content.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Both are backed by the same <code>site_settings</code> table, a general key/value
            store for exactly this kind of configuration. It holds one key today (the footer's
            content); the next site-wide setting — a contact address, an analytics id, a
            maintenance flag — belongs here too, as a new section beside these two, not a new
            screen of its own.
          </p>
        </div>
      )}

      {section === 'menus' && <MenusTab adminKey={adminKey} />}
      {section === 'footer' && <FooterTab adminKey={adminKey} />}
    </div>
  );
}

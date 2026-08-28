import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentUser, login, logout } from '../lib/auth';
import hilomLogo from '../assets/hilom-logo.png';
import { useMenus } from '../cms/useMenus';
import type { MenuLink } from '../lib/cms';
import RouteTransition from './RouteTransition';

export function money(centavos: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

/** Internal paths stay client-side; external ones open in a new tab. */
function MenuLinkView({ item }: { item: MenuLink }) {
  if (item.target === 'blank' || !item.href.startsWith('/')) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer">
        {item.label}
      </a>
    );
  }
  return <Link to={item.href}>{item.label}</Link>;
}

/** The `/account/*` sub-navigation, surfaced here under the username dropdown
 *  rather than as an in-page tab bar on AccountDashboard. */
const ACCOUNT_MENU = [
  { label: 'Overview', to: '/account/overview' },
  { label: 'Retreats & events', to: '/account/registrations' },
  { label: 'Sessions', to: '/account/bookings' },
  { label: 'Payments', to: '/account/payments' },
  { label: 'My details', to: '/account/details' },
] as const;

function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  // Close on route change and on any click outside the menu.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="who">{email}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="user-menu-panel" role="menu">
          {ACCOUNT_MENU.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              className={({ isActive }) =>
                isActive ? 'user-menu-item user-menu-item--active' : 'user-menu-item'
              }
            >
              {item.label}
            </NavLink>
          ))}
          <button type="button" className="user-menu-item" role="menuitem" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const user = currentUser();
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  const menus = useMenus();

  // Navigating with the menu open would otherwise leave it covering the new page.
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <>
      <header className="site-header">
        <div className="container inner">
          <Link className="brand" to="/">
            <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" />
          </Link>
          <button
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? '✕' : '☰'}
          </button>
          <nav className={navOpen ? 'nav open' : 'nav'}>
            {menus.header.map((item) => (
              <MenuLinkView key={`${item.label}-${item.href}`} item={item} />
            ))}
            {user ? (
              <UserMenu email={user.email} />
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => login(window.location.pathname + window.location.search)}
              >
                Log in
              </button>
            )}
          </nav>
        </div>
      </header>

      <main>
        <RouteTransition>{children}</RouteTransition>
      </main>

      <footer className="site-footer">
        <div className="container">
          <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" style={{ marginBottom: '0.9rem' }} />
          <p style={{ margin: 0 }}>
            © {new Date().getFullYear()} Hilom Collective
            {menus.footer.map((item) => (
              <span key={`${item.label}-${item.href}`}>
                {' · '}
                <MenuLinkView item={item} />
              </span>
            ))}
          </p>
        </div>
      </footer>
    </>
  );
}

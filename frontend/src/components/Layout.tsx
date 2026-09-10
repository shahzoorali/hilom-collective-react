import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentUser, hasGroup, login, logout } from '../lib/auth';
import { MOODLE_URL } from '../config';
import hilomLogo from '../assets/hilom-logo.png';
import { useMenus } from '../cms/useMenus';
import type { MenuLink } from '../lib/cms';
import RouteTransition from './RouteTransition';
import SiteFooter from './SiteFooter';

export function money(centavos: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

/**
 * `money()`, with a trailing ".00" dropped — ₱2,500 rather than ₱2,500.00.
 *
 * For marketing surfaces only (course cards, facilitator pricing): a whole
 * peso amount reads cleaner without it, and there's nothing here a customer
 * needs to reconcile against a bank statement. Receipts, checkout, and admin
 * money tables keep calling `money()` directly — those are financial records,
 * where a franc figure is exactly as precise as it should be and quietly
 * changing its format would be the wrong kind of surprise.
 *
 * A non-zero cents amount (e.g. ₱1,999.50) is left alone; only an exact ".00"
 * is trimmed.
 */
export function displayPrice(centavos: number, currency = 'PHP'): string {
  return money(centavos, currency).replace(/\.00$/, '');
}

/** Internal paths stay client-side; external ones open in a new tab. A menu
 *  item with style 'button' renders as a primary CTA rather than a plain link. */
function MenuLinkView({ item }: { item: MenuLink }) {
  const className = item.style === 'button' ? 'btn btn-primary' : undefined;
  if (item.target === 'blank' || !item.href.startsWith('/')) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" className={className}>
        {item.label}
      </a>
    );
  }
  return (
    <Link to={item.href} className={className}>
      {item.label}
    </Link>
  );
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
  const isFacilitator = hasGroup('facilitator');

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
          {isFacilitator && (
            <>
              <Link to="/facilitator" role="menuitem" className="user-menu-item">
                Facilitator dashboard
              </Link>
              <div className="user-menu-sep" role="separator" />
            </>
          )}
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
          <a
            href={`${MOODLE_URL}/my/`}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className="user-menu-item"
          >
            Hilom Learning Hub
          </a>
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
            {/* A quiet way in for people who already have an account. Any
                loud call-to-action button now lives in the editable header
                menu — add an item with style "Button" in Admin → Menus. */}
            <div className="nav-actions">
              {user ? (
                <UserMenu email={user.email} />
              ) : (
                <button
                  className="btn btn-ghost"
                  onClick={() => login(window.location.pathname + window.location.search)}
                >
                  Log in
                </button>
              )}
            </div>
          </nav>
        </div>
      </header>

      <main>
        <RouteTransition>{children}</RouteTransition>
      </main>

      <SiteFooter settings={menus.footerSettings} menus={menus.byKey} />
    </>
  );
}

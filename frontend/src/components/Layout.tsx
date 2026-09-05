import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentUser, login, logout } from '../lib/auth';
import { MOODLE_URL } from '../config';
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

/** The footer's site column. Hardcoded rather than CMS-driven: the editable
 *  footer menu carries legal and platform links, and mixing the two into one
 *  list is what made the old single-line footer unreadable. */
const FOOTER_EXPLORE = [
  { label: 'About Hilom', to: '/about' },
  { label: 'Services', to: '/services' },
  { label: 'Courses', to: '/courses' },
  { label: 'Facilitators', to: '/facilitators' },
  { label: 'Events', to: '/events' },
  { label: 'Journal', to: '/blog' },
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
            {/* Two right-hand actions rather than one: a quiet way in for
                people who already have an account, and the loud one that is
                the same phrase repeated at every scroll depth of the page. */}
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
              <Link className="btn btn-primary" to="/community">
                Join our community
              </Link>
            </div>
          </nav>
        </div>
      </header>

      <main>
        <RouteTransition>{children}</RouteTransition>
      </main>

      <footer className="site-footer">
        <div className="container">
          <div className="cv-foot">
            {/* Zone 1 — the brand, one closing line, and the same call to
                action the header opens with. */}
            <div className="cv-foot__cta">
              <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" />
              <p className="cv-foot__headline">Paghilom. Para sa lahat.</p>
              <Link className="btn btn-primary" to="/community">
                Join our community
              </Link>
            </div>

            {/* Zone 2 — how to reach a person. */}
            <div>
              <h3>Get in touch</h3>
              <ul className="cv-foot__contact">
                <li>
                  <a href="mailto:hello@hilomcollective.com">hello@hilomcollective.com</a>
                </li>
                <li>
                  <span>Metro Manila, Philippines</span>
                </li>
              </ul>
              <div className="cv-social">
                <a href="https://www.facebook.com/hilomcollective" target="_blank" rel="noreferrer" aria-label="Hilom Collective on Facebook">f</a>
                <a href="https://www.instagram.com/hilomcollective" target="_blank" rel="noreferrer" aria-label="Hilom Collective on Instagram">ig</a>
                <a href="https://www.tiktok.com/@hilomcollective" target="_blank" rel="noreferrer" aria-label="Hilom Collective on TikTok">tt</a>
              </div>
            </div>

            {/* Zone 3 — where to go next on the site. */}
            <div>
              <h3>Explore</h3>
              <ul className="cv-foot__list">
                {FOOTER_EXPLORE.map((item) => (
                  <li key={item.to}>
                    <Link to={item.to}>{item.label}</Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Zone 4 — the CMS-editable menu, which is where the legal and
                platform links live. */}
            <div>
              <h3>More</h3>
              <ul className="cv-foot__list">
                {menus.footer.map((item) => (
                  <li key={`${item.label}-${item.href}`}>
                    <MenuLinkView item={item} />
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="cv-foot__legal">
            <p>© {new Date().getFullYear()} Hilom Collective. All rights reserved.</p>
            <p>A holistic wellness platform rooted in Filipino life.</p>
          </div>
        </div>
      </footer>
    </>
  );
}

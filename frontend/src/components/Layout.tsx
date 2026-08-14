import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { currentUser, login, logout } from '../lib/auth';
import { MOODLE_URL } from '../config';
import hilomLogo from '../assets/hilom-logo.png';

export function money(centavos: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

export default function Layout({ children }: { children: ReactNode }) {
  const user = currentUser();
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();

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
            <Link to="/about">About Hilom</Link>
            <Link to="/services">Services</Link>
            <Link to="/events">Events</Link>
            <Link to="/community">Join Our Community</Link>
            <Link to="/courses">Courses</Link>
            <a href={MOODLE_URL} target="_blank" rel="noreferrer">
              Login to Hilom Learning Hub ➞
            </a>
            {user ? (
              <>
                <span className="who">{user.email}</span>
                <button className="btn btn-ghost" onClick={logout}>
                  Log out
                </button>
              </>
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

      <main>{children}</main>

      <footer className="site-footer">
        <div className="container">
          <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" style={{ marginBottom: '0.9rem' }} />
          <p style={{ margin: 0 }}>
            © {new Date().getFullYear()} Hilom Collective ·{' '}
            <a href={MOODLE_URL} target="_blank" rel="noreferrer">
              Learning platform
            </a>
          </p>
        </div>
      </footer>
    </>
  );
}

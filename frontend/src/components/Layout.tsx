import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { currentUser, login, logout } from '../lib/auth';
import { MOODLE_URL } from '../config';
import hilomLogo from '../assets/hilom-logo.png';

export function money(centavos: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

export default function Layout({ children }: { children: ReactNode }) {
  const user = currentUser();
  const navigate = useNavigate();

  return (
    <>
      <header className="site-header">
        <div className="container inner">
          <Link className="brand" to="/">
            <img src={hilomLogo} alt="Hilom Collective" className="brand-logo" />
          </Link>
          <nav className="nav">
            <Link to="/courses">Courses</Link>
            <a href={MOODLE_URL} target="_blank" rel="noreferrer">
              My learning
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
            </a>{' '}
            ·{' '}
            <button
              className="btn-ghost"
              style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
              onClick={() => navigate('/admin')}
            >
              Admin
            </button>
          </p>
        </div>
      </footer>
    </>
  );
}

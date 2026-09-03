/**
 * `/facilitator/*` — the facilitator's own dashboard.
 *
 * Mirrors `Admin.tsx`'s tab shell, with one deliberate difference: there is no
 * key prompt. Access comes from the Cognito `facilitator` group on the signed-in
 * user's token, so the gate here is "are you in the group", and the group is
 * granted by an admin approving the application.
 *
 * The group check in this file decides what to *render*. It is not the security
 * boundary — every endpoint behind these screens re-checks the group on the
 * verified token and scopes each query to the caller's own facilitator row.
 * Editing `groups` in devtools gets you a dashboard that returns 401s.
 *
 * A newly approved facilitator still holds a group-less token until they sign
 * in again — Cognito stamps groups at token issue — which is why the
 * "no access" branch offers a re-sign-in rather than only an explanation.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import hilomLogo from '../assets/hilom-logo.png';
import { currentUser, login, logout } from '../lib/auth';
import { money } from '../components/Layout';
import {
  getMyEarnings,
  getMyFacilitatorProfile,
  listMyFacilitatorBookings,
  cancelMyFacilitatorBooking,
  markNoShow,
  formatDualZone,
  viewerTimezone,
  type Booking,
  type EarningsTotals,
  type OwnProfile,
  type Payout,
} from '../lib/booking';

const ServicesTab = lazy(() => import('./facilitator/ServicesTab'));
const AvailabilityTab = lazy(() => import('./facilitator/AvailabilityTab'));
const ProfileTab = lazy(() => import('./facilitator/ProfileTab'));
const ConnectionsTab = lazy(() => import('./facilitator/ConnectionsTab'));

const TABS = [
  { label: 'Overview', path: 'overview', icon: '📊' },
  { label: 'Bookings', path: 'bookings', icon: '📅' },
  { label: 'Services', path: 'services', icon: '🌿' },
  { label: 'Availability', path: 'availability', icon: '🕰️' },
  { label: 'Earnings', path: 'earnings', icon: '💰' },
  { label: 'Profile', path: 'profile', icon: '👤' },
  { label: 'Connections', path: 'connections', icon: '🔗' },
] as const;

export default function FacilitatorDashboard() {
  const user = currentUser();
  const location = useLocation();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isFacilitator = user?.groups.includes('facilitator') ?? false;

  useEffect(() => {
    if (!isFacilitator) {
      setLoading(false);
      return;
    }
    let live = true;
    getMyFacilitatorProfile()
      .then((p) => live && setProfile(p))
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [isFacilitator]);

  if (!user) {
    return (
      <Gate title="Facilitator dashboard">
        <p style={{ marginTop: 0 }}>Sign in to manage your sessions.</p>
        <button className="btn btn-accent btn-block" type="button" onClick={() => void login('/facilitator')}>
          Continue with your Hilom account
        </button>
      </Gate>
    );
  }

  if (!isFacilitator) {
    return (
      <Gate title="Facilitator dashboard">
        <p style={{ marginTop: 0 }}>
          This account ({user.email}) isn't set up as a facilitator yet.
        </p>
        <p className="small muted">
          If you've just been approved, sign in again — your access is attached to a fresh sign-in.
        </p>
        <button className="btn btn-accent btn-block" type="button" onClick={() => { logout(); void login('/facilitator'); }}>
          Sign in again
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Not a facilitator yet? <Link to="/facilitators/apply">Apply to facilitate</Link>, or{' '}
          <Link to="/facilitators">see who's already on Hilom</Link>.
        </p>
      </Gate>
    );
  }

  if (loading) {
    return (
      <div className="admin-shell">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <Gate title="Facilitator dashboard">
        <div className="alert alert-error">{error ?? 'No facilitator profile found'}</div>
      </Gate>
    );
  }

  const active = location.pathname.split('/')[2] ?? 'overview';

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <img src={hilomLogo} alt="Hilom" style={{ height: 28 }} />
        <span className="small muted">{profile.display_name}</span>
        <span className={`pill ${profile.status === 'published' ? 'pill-ok' : 'pill-warn'}`}>
          {profile.status === 'published' ? 'Live' : 'Not yet listed'}
        </span>
        <div className="row" style={{ marginLeft: 'auto', gap: '0.5rem' }}>
          {profile.status === 'published' && (
            <Link className="btn btn-ghost small" to={`/facilitators/${profile.slug}`}>
              View profile
            </Link>
          )}
          <button className="btn btn-ghost small" type="button" onClick={() => { logout(); navigate('/'); }}>
            Log out
          </button>
        </div>
      </header>

      <nav className="admin-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={`admin-tab-btn${active === tab.path ? ' admin-tab-btn--active' : ''}`}
            onClick={() => navigate(`/facilitator/${tab.path}`)}
          >
            <span aria-hidden="true">{tab.icon}</span> {tab.label}
          </button>
        ))}
      </nav>

      <main className="admin-content">
        <Suspense fallback={<div className="spinner" aria-label="Loading" />}>
          <Routes>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Overview profile={profile} />} />
            <Route path="bookings" element={<BookingsTab />} />
            <Route path="services" element={<ServicesTab />} />
            <Route path="availability" element={<AvailabilityTab timezone={profile.timezone} />} />
            <Route path="earnings" element={<EarningsTab />} />
            <Route path="profile" element={<ProfileTab profile={profile} onSaved={setProfile} />} />
            <Route path="connections" element={<ConnectionsTab />} />
            <Route path="*" element={<Navigate to="overview" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 520 }}>
        <h1>{title}</h1>
        <div className="panel">{children}</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({ profile }: { profile: OwnProfile }) {
  const [earnings, setEarnings] = useState<{ thisMonth: EarningsTotals; awaitingPayout: EarningsTotals } | null>(
    null,
  );
  const [bookings, setBookings] = useState<Booking[] | null>(null);

  useEffect(() => {
    let live = true;
    void getMyEarnings().then((r) => live && setEarnings(r));
    void listMyFacilitatorBookings().then((r) => live && setBookings(r.bookings));
    return () => {
      live = false;
    };
  }, []);

  const zone = viewerTimezone();
  const now = Date.now();
  const upcoming = (bookings ?? [])
    .filter((b) => b.status === 'confirmed' && new Date(b.starts_at).getTime() > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 5);

  return (
    <>
      {profile.status !== 'published' && (
        <div className="alert alert-info">
          <strong>You're not listed yet.</strong> Set up your services and availability — Hilom
          publishes your profile once it's ready.
        </div>
      )}

      <div className="admin-stats-grid">
        <Stat label="Sessions this month" value={String(earnings?.thisMonth.sessions ?? '—')} />
        <Stat label="Gross this month" value={earnings ? money(earnings.thisMonth.gross) : '—'} />
        <Stat label="Hilom fees" value={earnings ? `−${money(earnings.thisMonth.fees)}` : '—'} />
        <Stat label="Your earnings" value={earnings ? money(earnings.thisMonth.net) : '—'} />
      </div>

      <h2>Next sessions</h2>
      {bookings === null && <div className="spinner" aria-label="Loading" />}
      {bookings !== null && upcoming.length === 0 && (
        <p className="muted">Nothing booked yet.</p>
      )}
      {upcoming.map((b) => (
        <div key={b.id} className="card" style={{ marginBottom: '0.6rem' }}>
          <strong>{b.facilitator_services?.title ?? 'Session'}</strong>
          <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
            {formatDualZone(
              b.starts_at,
              { timezone: b.client_timezone, label: 'for them' },
              { dateStyle: 'medium', timeStyle: 'short' },
              zone,
            )}{' '}
            · {b.client_name || b.client_email}
          </p>
        </div>
      ))}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-stat-card">
      <span className="admin-stat-card__label">{label}</span>
      <span className="admin-stat-card__value">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function BookingsTab() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function reload() {
    listMyFacilitatorBookings()
      .then((r) => setBookings(r.bookings))
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => reload(), []);

  async function onCancel(booking: Booking) {
    if (
      !window.confirm(
        'Cancel this session?\n\nThe client is refunded in full and notified by email, whatever the notice period.',
      )
    )
      return;
    setBusyId(booking.id);
    try {
      await cancelMyFacilitatorBooking(booking.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusyId(null);
    }
  }

  async function onNoShow(booking: Booking) {
    setBusyId(booking.id);
    try {
      await markNoShow(booking.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  }

  const zone = viewerTimezone();
  const now = Date.now();

  return (
    <>
      <h2>Bookings</h2>
      {error && <div className="alert alert-error">{error}</div>}
      {bookings === null && <div className="spinner" aria-label="Loading" />}
      {bookings !== null && bookings.length === 0 && <p className="muted">No bookings yet.</p>}

      {(bookings ?? []).map((b) => {
        const isFuture = new Date(b.starts_at).getTime() > now;
        return (
          <div key={b.id} className="card" style={{ marginBottom: '0.75rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{b.facilitator_services?.title ?? 'Session'}</strong>
              <span className="pill">{b.status.replace(/_/g, ' ')}</span>
            </div>
            <p className="small" style={{ margin: '0.4rem 0' }}>
              {/* Both zones, always — see formatDualZone. A facilitator who
                  only ever sees their own time is the one who books a Sydney
                  client into their 6am. */}
              {formatDualZone(
                b.starts_at,
                { timezone: b.client_timezone, label: 'for your client' },
                { dateStyle: 'full', timeStyle: 'short' },
                zone,
              )}
            </p>
            <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
              {b.client_name || b.client_email} · {b.client_email} ·{' '}
              {b.price_centavos === 0 ? 'Complimentary' : `you earn ${money(b.facilitator_net_centavos)}`}
            </p>
            {b.client_notes && (
              <p className="small" style={{ margin: '0 0 0.5rem' }}>
                <em>“{b.client_notes}”</em>
              </p>
            )}
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {b.meeting_url && isFuture && (
                <a className="btn btn-ghost small" href={b.meeting_url} target="_blank" rel="noreferrer">
                  Join
                </a>
              )}
              {b.status === 'confirmed' && isFuture && (
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busyId === b.id}
                  onClick={() => void onCancel(b)}
                >
                  Cancel
                </button>
              )}
              {(b.status === 'completed' || (b.status === 'confirmed' && !isFuture)) && (
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busyId === b.id}
                  onClick={() => void onNoShow(b)}
                >
                  Mark no-show
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

function EarningsTab() {
  const [data, setData] = useState<{
    thisMonth: EarningsTotals;
    awaitingPayout: EarningsTotals;
    platformFeeBps: number;
    payouts: Payout[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMyEarnings()
      .then((r) => live && setData(r))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <div className="spinner" aria-label="Loading" />;

  return (
    <>
      <h2>Earnings</h2>

      {/* The split is shown in full rather than as one net figure. A
          facilitator who cannot see the fee they are paying does not trust the
          number, and that mistrust is what loses a marketplace its supply. */}
      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>This month</h3>
        <Line label={`Gross (${data.thisMonth.sessions} sessions)`} value={money(data.thisMonth.gross)} />
        <Line
          label={`Hilom platform fee (${(data.platformFeeBps / 100).toFixed(data.platformFeeBps % 100 ? 2 : 0)}%)`}
          value={`−${money(data.thisMonth.fees)}`}
        />
        <hr />
        <Line label="Your earnings" value={money(data.thisMonth.net)} strong />
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Awaiting payout</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Delivered sessions not yet included in a payout.
        </p>
        <Line label={`${data.awaitingPayout.sessions} sessions`} value={money(data.awaitingPayout.net)} strong />
      </div>

      <h3>Payout history</h3>
      {data.payouts.length === 0 && <p className="muted">No payouts yet.</p>}
      {data.payouts.map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: '0.6rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{money(p.net_centavos)}</strong>
            <span className={`pill ${p.status === 'paid' ? 'pill-ok' : 'pill-warn'}`}>{p.status}</span>
          </div>
          <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(p.period_start))} –{' '}
            {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(p.period_end))}
            {p.reference && <> · ref {p.reference}</>}
          </p>
        </div>
      ))}
    </>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', margin: '0.35rem 0' }}>
      <span className={strong ? undefined : 'muted'}>{label}</span>
      {strong ? <strong>{value}</strong> : <span>{value}</span>}
    </div>
  );
}

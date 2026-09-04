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
import MessageThread from '../components/MessageThread';
import AddToCalendar from '../components/AddToCalendar';
import {
  getMyEarnings,
  getMyFacilitatorProfile,
  listMyFacilitatorBookings,
  cancelMyFacilitatorBooking,
  createBookingForClient,
  listMyServices,
  markNoShow,
  previewMySlots,
  proposeNewTime,
  withdrawProposedTime,
  formatInZone,
  type FacilitatorService,
  type SlotOption,
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
const ClientsTab = lazy(() => import('./facilitator/ClientsTab'));
const MessagesTab = lazy(() => import('./facilitator/MessagesTab'));

/**
 * Is this confirmed session inside the facilitator's vacation window?
 *
 * `vacation_until` blocks new bookings but leaves existing ones alone (see
 * vacationConflicts in facilitator-portal.ts — reporting is deliberate, and
 * auto-cancelling a week of sessions off a date field is not). So the dashboard
 * has to be the thing that keeps saying so, not just the save that set it.
 */
function inVacation(booking: Booking, vacationUntil: string | null | undefined): boolean {
  if (!vacationUntil || booking.status !== 'confirmed') return false;
  const startsAt = new Date(booking.starts_at).getTime();
  return startsAt > Date.now() && startsAt < new Date(vacationUntil).getTime();
}

const TABS = [
  { label: 'Overview', path: 'overview', icon: '📊' },
  { label: 'Bookings', path: 'bookings', icon: '📅' },
  { label: 'Clients', path: 'clients', icon: '🫂' },
  { label: 'Messages', path: 'messages', icon: '💬' },
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
            <Route path="bookings" element={<BookingsTab profile={profile} />} />
            <Route path="clients" element={<ClientsTab />} />
            <Route path="messages" element={<MessagesTab />} />
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

  const awayConflicts = (bookings ?? []).filter((b) => inVacation(b, profile.vacation_until));

  return (
    <>
      {profile.status !== 'published' && (
        <div className="alert alert-info">
          <strong>You're not listed yet.</strong> Set up your services and availability — Hilom
          publishes your profile once it's ready.
        </div>
      )}

      {/* Kept on screen for the whole away period rather than shown once at
          save time: someone books time off in March for a trip in June, and
          the sessions that need moving are the ones they will have forgotten. */}
      {awayConflicts.length > 0 && (
        <div className="alert alert-warning">
          <strong>
            You have {awayConflicts.length} confirmed{' '}
            {awayConflicts.length === 1 ? 'session' : 'sessions'} during your time off.
          </strong>{' '}
          New bookings are paused until{' '}
          {formatDualZone(
            profile.vacation_until as string,
            { timezone: null, label: '' },
            { dateStyle: 'medium' },
            zone,
          )}
          , but these were already booked.{' '}
          <Link to="/facilitator/bookings">Review them</Link>.
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

/**
 * Pick a time to offer the client instead of cancelling on them.
 *
 * Draws its options from `previewMySlots` — the facilitator's own view of the
 * slot engine — rather than the public availability endpoint, so it obeys
 * exactly the rules a real booking would while still working on an unpublished
 * profile or a hidden service.
 *
 * Nothing here moves the session. It records an offer; the client's answer is
 * what moves it (see 0029).
 */
/**
 * Book a client in by hand.
 *
 * For everything the public paid flow does not cover: someone who paid by bank
 * transfer or in cash, a pro-bono session, a goodwill rebooking after a
 * cancellation, the long-standing client who has always just texted.
 *
 * The copy is careful about one thing above all — that what they type into
 * "what they paid you" is a note for their own records and not a sum Hilom will
 * ever send them. That is the money rule from 0031, and a facilitator who
 * believed otherwise would be waiting on a payout that is never coming.
 *
 * Times come from `previewMySlots`, the same engine a client's picker uses, so
 * the offered slots are genuinely free ones.
 */
function BookAClient({
  timezone,
  onBooked,
}: {
  timezone: string;
  onBooked: (message: string) => void;
}) {
  const [services, setServices] = useState<FacilitatorService[] | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [clientEmail, setClientEmail] = useState('');
  const [clientName, setClientName] = useState('');
  const [paidPesos, setPaidPesos] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listMyServices()
      .then((list) => {
        setServices(list);
        if (list.length > 0) setServiceId((current) => current || list[0].id);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!serviceId) return;
    let live = true;
    setSlots(null);
    setChosen(null);
    const from = new Date();
    const to = new Date(from.getTime() + 28 * 86_400_000);
    previewMySlots(serviceId, from, to)
      .then((r) => live && setSlots(r.slots))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [serviceId]);

  async function submit() {
    if (!chosen || !clientEmail) return;
    setBusy(true);
    setError(null);
    try {
      await createBookingForClient({
        serviceId,
        clientEmail,
        clientName: clientName || undefined,
        startsAt: chosen,
        offPlatformPesos: paidPesos || undefined,
        note: note || undefined,
      });
      onBooked(`Booked — we've emailed ${clientEmail} the details.`);
      setClientEmail('');
      setClientName('');
      setPaidPesos('');
      setNote('');
      setChosen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not book that');
    } finally {
      setBusy(false);
    }
  }

  const byDay = new Map<string, SlotOption[]>();
  for (const slot of slots ?? []) {
    const day = formatInZone(slot.startsAt, timezone, { dateStyle: 'full', timeStyle: undefined });
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }

  if (services !== null && services.length === 0) {
    return (
      <div className="panel">
        <p className="small muted" style={{ margin: 0 }}>
          Set up a session under Services first — that is what says how long it runs and how it is
          delivered.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="two-col">
        <label className="field">
          <span>Which session</span>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {(services ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Their email</span>
          <input
            type="email"
            value={clientEmail}
            onChange={(e) => setClientEmail(e.target.value)}
            placeholder="them@example.com"
          />
          <small className="muted">
            They do not need a Hilom account. If they make one later with this address, the session
            is already there.
          </small>
        </label>
      </div>

      <label className="field">
        <span>Their name (optional)</span>
        <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
      </label>

      {error && <div className="alert alert-error">{error}</div>}

      <p className="small muted" style={{ marginBottom: '0.3rem' }}>
        Pick a time — these are your genuinely free slots, in your own zone.
      </p>
      {slots === null && <div className="spinner" aria-label="Loading" />}
      {slots !== null && slots.length === 0 && (
        <p className="muted small">
          No free times in the next four weeks. Open some hours under Availability first.
        </p>
      )}
      {[...byDay.entries()].map(([day, daySlots]) => (
        <div key={day} style={{ marginBottom: '0.5rem' }}>
          <strong className="small">{day}</strong>
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
            {daySlots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                className={chosen === slot.startsAt ? 'btn btn-accent small' : 'btn btn-ghost small'}
                onClick={() => setChosen(slot.startsAt)}
              >
                {formatInZone(slot.startsAt, timezone, { dateStyle: undefined, timeStyle: 'short' })}
              </button>
            ))}
          </div>
        </div>
      ))}

      {chosen && (
        <>
          <div className="two-col">
            <label className="field">
              <span>What they paid you (₱, optional)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={paidPesos}
                onChange={(e) => setPaidPesos(e.target.value)}
                placeholder="Leave blank for pro bono"
              />
            </label>
            <label className="field">
              <span>Note to yourself (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Paid by bank transfer, 12 Sept"
              />
            </label>
          </div>

          {/* The one thing that must not be misunderstood. */}
          <div className="alert alert-info">
            No payment is taken and nothing is owed to you by Hilom for this session — you have
            already been paid, or chosen not to be. What you type above is a note for your own
            records; it stays out of your Hilom earnings and payouts.
          </div>

          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || !clientEmail}
            onClick={() => void submit()}
          >
            {busy ? 'Booking…' : 'Book this session'}
          </button>
        </>
      )}
    </div>
  );
}

function ProposeTime({
  booking,
  timezone,
  onDone,
}: {
  booking: Booking;
  timezone: string;
  onDone: (message: string) => void;
}) {
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const from = new Date();
    const to = new Date(from.getTime() + 21 * 86_400_000);
    previewMySlots(booking.service_id, from, to)
      .then((r) => live && setSlots(r.slots))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [booking.service_id]);

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await proposeNewTime(booking.id, chosen, note || undefined);
      onDone("Suggested — we've emailed your client. The session stays as it is until they accept.");
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not suggest that time');
    } finally {
      setBusy(false);
    }
  }

  // Grouped by the facilitator's local day, the unit they actually think in.
  const byDay = new Map<string, SlotOption[]>();
  for (const slot of slots ?? []) {
    const day = formatInZone(slot.startsAt, timezone, { dateStyle: 'full', timeStyle: undefined });
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }

  return (
    <div className="panel" style={{ marginBottom: '0.75rem' }}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Your client keeps their current time unless they accept. Times are shown in your zone.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {slots === null && !error && <div className="spinner" aria-label="Loading" />}
      {slots !== null && slots.length === 0 && (
        <p className="muted small">
          You have no free times in the next three weeks. Open some hours under Availability first.
        </p>
      )}

      {[...byDay.entries()].map(([day, daySlots]) => (
        <div key={day} style={{ marginBottom: '0.5rem' }}>
          <strong className="small">{day}</strong>
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
            {daySlots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                className={chosen === slot.startsAt ? 'btn btn-accent small' : 'btn btn-ghost small'}
                onClick={() => setChosen(slot.startsAt)}
              >
                {formatInZone(slot.startsAt, timezone, { dateStyle: undefined, timeStyle: 'short' })}
              </button>
            ))}
          </div>
        </div>
      ))}

      {chosen && (
        <>
          <label className="field">
            <span>A note for your client (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="I'm so sorry — I have a clinic that morning."
            />
          </label>
          <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Sending…' : 'Suggest this time'}
          </button>
        </>
      )}
    </div>
  );
}

function BookingsTab({ profile }: { profile: OwnProfile }) {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Which booking's "suggest another time" panel is open, if any.
  const [proposingId, setProposingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Which booking's conversation is open inline, if any.
  const [messagingId, setMessagingId] = useState<string | null>(null);

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

  async function onWithdraw(booking: Booking) {
    setBusyId(booking.id);
    setError(null);
    try {
      await withdrawProposedTime(booking.id);
      setNotice('Suggestion withdrawn.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not withdraw');
    } finally {
      setBusyId(null);
    }
  }

  const zone = viewerTimezone();
  const now = Date.now();

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Bookings</h2>
        <button
          type="button"
          className="btn btn-accent small"
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? 'Close' : 'Book a client in'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {/* For sessions arranged outside the public flow — paid offline, pro
          bono, a goodwill rebooking. The money is recorded as zero on purpose;
          see 0031 and the note inside the form. */}
      {adding && (
        <BookAClient
          timezone={zone}
          onBooked={(message) => {
            setAdding(false);
            setNotice(message);
            reload();
          }}
        />
      )}
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
            {/* Vacation mode never touched sessions already in the diary; this
                is where the facilitator finds the ones that need a decision. */}
            {inVacation(b, profile.vacation_until) && (
              <p className="small" style={{ margin: '0.35rem 0 0', color: '#8a5a08' }}>
                This falls inside your time off — cancel or move it.
              </p>
            )}
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
              {/* A session the facilitator entered themselves carries zero in
                  every money column (0031), so "Complimentary" would be a lie
                  about one they were paid for offline. */}
              {b.booked_by === 'facilitator'
                ? b.off_platform_centavos
                  ? `booked by you · they paid you ${money(b.off_platform_centavos)} directly`
                  : 'booked by you · nothing charged through Hilom'
                : b.price_centavos === 0
                  ? 'Complimentary'
                  : `you earn ${money(b.facilitator_net_centavos)}`}
            </p>
            {b.facilitator_note && (
              <p className="small muted" style={{ margin: '0 0 0.5rem' }}>
                Your note: {b.facilitator_note}
              </p>
            )}
            {b.client_notes && (
              <p className="small" style={{ margin: '0 0 0.5rem' }}>
                <em>“{b.client_notes}”</em>
              </p>
            )}

            {/* The intake answers, rendered from the labels stored *with* them
                rather than by looking the questions up again — a form rewritten
                since must not change what this client was asked (0032). */}
            {b.intake_answers && b.intake_answers.length > 0 && (
              <details style={{ margin: '0 0 0.5rem' }}>
                <summary className="small">
                  Their pre-session answers
                  {b.intake_completed_at
                    ? ` · ${formatInZone(b.intake_completed_at, zone, { dateStyle: 'medium', timeStyle: undefined })}`
                    : ''}
                </summary>
                <dl className="small" style={{ margin: '0.4rem 0 0' }}>
                  {b.intake_answers.map((a) => (
                    <div key={a.id} style={{ marginBottom: '0.35rem' }}>
                      <dt className="muted">{a.label}</dt>
                      <dd style={{ margin: 0 }}>{a.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}

            {/* Only worth saying for a session that has not happened yet:
                afterwards it is a fact about the past, not something to chase. */}
            {b.status === 'confirmed' &&
              isFuture &&
              !b.intake_completed_at &&
              b.facilitator_services?.intake_questions &&
              b.facilitator_services.intake_questions.length > 0 && (
                <p className="small" style={{ margin: '0 0 0.5rem', color: '#8a5a08' }}>
                  They haven't filled in your pre-session form yet. Their reminder email asks them
                  to.
                </p>
              )}
            {b.proposed_starts_at && (
              <div className="alert alert-info" style={{ marginBottom: '0.5rem' }}>
                Waiting on your client — you suggested{' '}
                <strong>
                  {formatInZone(b.proposed_starts_at, zone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </strong>
                . The session below is still the one that stands.{' '}
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busyId === b.id}
                  onClick={() => void onWithdraw(b)}
                >
                  Withdraw
                </button>
              </div>
            )}

            {proposingId === b.id && (
              <ProposeTime
                booking={b}
                timezone={zone}
                onDone={(message) => {
                  setProposingId(null);
                  setNotice(message);
                  reload();
                }}
              />
            )}

            {messagingId === b.id && (
              <MessageThread
                bookingId={b.id}
                side="facilitator"
                otherName={(b.client_name || b.client_email).split(' ')[0] ?? 'your client'}
              />
            )}

            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* Also reachable from the Messages tab. Offered here too because
                  "can we start ten minutes later?" is a thought someone has
                  while looking at the session, not at an inbox. */}
              <button
                type="button"
                className="btn btn-ghost small"
                onClick={() => setMessagingId(messagingId === b.id ? null : b.id)}
              >
                {messagingId === b.id ? 'Close messages' : 'Message'}
              </button>
              {b.meeting_url && isFuture && (
                <a className="btn btn-ghost small" href={b.meeting_url} target="_blank" rel="noreferrer">
                  Join
                </a>
              )}
              {/* Same event the confirmation email already carries as an
                  invite attachment — offered directly for the dashboard case
                  the email can't cover: looking at this hours or days later. */}
              {isFuture && (
                <AddToCalendar
                  small
                  event={{
                    id: b.id,
                    title: `${b.facilitator_services?.title ?? 'Session'} with ${b.client_name || b.client_email}`,
                    startsAt: b.starts_at,
                    endsAt: b.ends_at,
                    location: b.meeting_url ?? undefined,
                    description: b.meeting_url ? `Join: ${b.meeting_url}` : undefined,
                  }}
                />
              )}
              {/* Offered before Cancel, and deliberately: cancelling refunds
                  the client in full and loses the booking, and for "something
                  came up" that is almost never what the facilitator wants. */}
              {b.status === 'confirmed' && isFuture && !b.proposed_starts_at && (
                <button
                  type="button"
                  className="btn btn-ghost small"
                  disabled={busyId === b.id}
                  onClick={() => setProposingId(proposingId === b.id ? null : b.id)}
                >
                  {proposingId === b.id ? 'Never mind' : 'Suggest another time'}
                </button>
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
    offPlatformThisMonth: { sessions: number; centavos: number };
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

      {/* Kept out of the totals above and given its own panel, because it is
          money Hilom never touched — see 0031. A facilitator whose month shows
          six sessions and four sessions' worth of earnings needs to see the
          other two accounted for somewhere, or the numbers look broken. */}
      {data.offPlatformThisMonth.sessions > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Arranged by you this month</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Sessions you booked in yourself. No payment went through Hilom, so no fee was charged
            and nothing here is owed to you by Hilom — it is recorded for your own books.
          </p>
          <Line
            label={`${data.offPlatformThisMonth.sessions} session${data.offPlatformThisMonth.sessions === 1 ? '' : 's'}`}
            value={
              data.offPlatformThisMonth.centavos > 0
                ? `${money(data.offPlatformThisMonth.centavos)} paid to you directly`
                : 'nothing recorded'
            }
          />
        </div>
      )}

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

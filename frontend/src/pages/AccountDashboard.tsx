/**
 * `/account/*` — the signed-in buyer's own dashboard.
 *
 * Mirrors FacilitatorDashboard.tsx's tab shell structurally — a `TABS` array,
 * the same `.admin-tabs`/`.admin-tab-btn` styling, `location.pathname.split('/')[2]`
 * deciding the active tab, and nested `<Routes>` in `<Suspense>` with an index
 * `<Navigate>`. Two deliberate differences from that shell:
 *
 *  * **No group gate.** Any signed-in buyer belongs here — there is no
 *    approval step the way there is for a facilitator.
 *
 *  * **It lives inside `<Layout>`**, not full-viewport like `/admin` and
 *    `/facilitator`. Someone checking a payment schedule is still a customer
 *    of the marketing site, not staff at a console — so the site's own
 *    header and footer stay visible, and this only takes over the tab bar
 *    and the content area below it, not the whole page. `.admin-shell`'s
 *    `height: 100vh` takeover is deliberately not reused here for that
 *    reason; only the tab-styling classes are.
 *
 * `/account/bookings` is folded in as the "Sessions" tab rather than kept as
 * its own top-level route. It has to keep resolving regardless — the URL is
 * already in sent email (booking-email.ts's ACCOUNT_BOOKINGS_URL) — and it
 * does, because `bookings` is still the literal path segment under `/account`.
 */
import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';

const Overview = lazy(() => import('./account/Overview'));
const RegistrationsTab = lazy(() => import('./account/RegistrationsTab'));
const RegistrationDetail = lazy(() => import('./account/RegistrationDetail'));
const Receipt = lazy(() => import('./account/Receipt'));
const BookingsTab = lazy(() => import('./account/BookingsTab'));
const PaymentsTab = lazy(() => import('./account/PaymentsTab'));
const DetailsTab = lazy(() => import('./account/DetailsTab'));

export default function AccountDashboard() {
  const user = currentUser();
  const location = useLocation();

  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 520 }}>
          <h1>Your account</h1>
          <div className="panel">
            <p style={{ marginTop: 0 }}>Sign in to see your events, sessions and payments.</p>
            <button
              type="button"
              className="btn btn-accent btn-block"
              onClick={() => void login(location.pathname)}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section" style={{ paddingTop: '1.5rem' }}>
      <div className="container">
        <Suspense fallback={<div className="spinner" aria-label="Loading" />}>
          <Routes>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="registrations" element={<RegistrationsTab />} />
            <Route path="registrations/:registrationId" element={<RegistrationDetail />} />
            <Route path="registrations/:registrationId/receipts/:chargeId" element={<Receipt />} />
            <Route path="bookings" element={<BookingsTab />} />
            <Route path="payments" element={<PaymentsTab />} />
            <Route path="details" element={<DetailsTab />} />
            <Route path="*" element={<Navigate to="overview" replace />} />
          </Routes>
        </Suspense>
      </div>
    </section>
  );
}

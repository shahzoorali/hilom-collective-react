import { lazy, Suspense } from 'react';
import Facilitators from './pages/Facilitators';
import FacilitatorApply from './pages/FacilitatorApply';
import FacilitatorProfile from './pages/FacilitatorProfile';
import BookingFlow from './pages/BookingFlow';
import BookingProcessing from './pages/BookingProcessing';
import EventRegister from './pages/EventRegister';
import RegistrationProcessing from './pages/RegistrationProcessing';
import AccountBookings from './pages/AccountBookings';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import CmsOrFallback from './components/CmsOrFallback';
import Home from './pages/Home';
import Courses from './pages/Courses';
import ProductDetail from './pages/ProductDetail';
import Checkout from './pages/Checkout';
import Processing from './pages/Processing';
import AuthCallback from './pages/AuthCallback';
import CmsPage from './pages/CmsPage';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';

/**
 * The admin is lazy-loaded because it pulls in Puck, which is far larger than
 * the entire public site. Statically imported it more than doubled the entry
 * bundle and made every visitor download a page editor they will never open.
 */
const Admin = lazy(() => import('./pages/Admin'));
// Lazy for the same reason as the admin: its own chrome, its own tabs, and
// nobody browsing the public site should download it.
const FacilitatorDashboard = lazy(() => import('./pages/FacilitatorDashboard'));
import About from './pages/About';
import Services from './pages/Services';
import Events from './pages/Events';
import Community from './pages/Community';

/**
 * Routes come in three kinds:
 *  - code-only pages (courses, checkout, auth, admin), which the CMS must never
 *    shadow — backend/src/lib/slug.ts refuses those slugs for that reason;
 *  - the five original marketing pages, each served from the CMS when published
 *    and from its JSX component otherwise (see CmsOrFallback);
 *  - `/:slug`, which serves any other published CMS page.
 *
 * React Router ranks specific paths above the `/:slug` parameter, so the
 * catch-all cannot steal a hardcoded route.
 *
 * `/admin/*` sits OUTSIDE <Layout>: the admin is a separate application, not a
 * page on the marketing site, so it gets its own chrome (Admin.tsx) rather
 * than the public header/nav/footer. Putting the storefront's own navigation
 * above a page editor was exactly what made the editor feel cramped and
 * confusable with the site being edited.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<p className="muted" style={{ padding: '2rem' }}>Loading…</p>}>
              <Admin />
            </Suspense>
          }
        />
        {/* Outside <Layout> like the admin — a facilitator managing their
            calendar is working, not browsing the marketing site. */}
        <Route
          path="/facilitator/*"
          element={
            <Suspense fallback={<p className="muted" style={{ padding: '2rem' }}>Loading…</p>}>
              <FacilitatorDashboard />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <Layout>
              <Routes>
                <Route path="/" element={<CmsOrFallback slug="home" fallback={<Home />} />} />
                <Route path="/about" element={<CmsOrFallback slug="about" fallback={<About />} />} />
                <Route path="/services" element={<CmsOrFallback slug="services" fallback={<Services />} />} />
                <Route path="/events" element={<CmsOrFallback slug="events" fallback={<Events />} />} />
                <Route path="/community" element={<CmsOrFallback slug="community" fallback={<Community />} />} />
                <Route path="/courses" element={<Courses />} />
                <Route path="/courses/:slug" element={<ProductDetail />} />
                <Route path="/checkout/processing" element={<Processing />} />
                <Route path="/checkout/:slug" element={<Checkout />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                {/* Literal before the {eventId} route, and both above the
                    /:slug CMS catch-all so no page can shadow them. */}
                <Route path="/events/registration/processing" element={<RegistrationProcessing />} />
                <Route path="/events/:eventId/register" element={<EventRegister />} />
                {/* Above the /:slug CMS catch-all, and mirrored in
                    RESERVED_SLUGS server-side so no CMS page can shadow them. */}
                <Route path="/facilitators" element={<Facilitators />} />
                {/* Above /facilitators/:slug — a literal "apply" must never be
                    read as a facilitator's slug. React Router ranks static
                    segments over params regardless of order, but the ordering
                    here matches the same rule on the API side (see the
                    facilitator marketplace routes in the CDK stack). */}
                <Route
                  path="/facilitators/apply"
                  element={<CmsOrFallback slug="facilitators-apply" fallback={<FacilitatorApply />} />}
                />
                <Route path="/facilitators/:slug" element={<FacilitatorProfile />} />
                <Route path="/book/:slug/:serviceId" element={<BookingFlow />} />
                <Route path="/booking/processing" element={<BookingProcessing />} />
                <Route path="/account/bookings" element={<AccountBookings />} />
                <Route path="/blog" element={<Blog />} />
                <Route path="/blog/category/:categorySlug" element={<Blog />} />
                <Route path="/blog/:slug" element={<BlogPost />} />
                <Route path="/:slug" element={<CmsPage />} />
                <Route path="*" element={<CmsPage />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import CmsOrFallback from './components/CmsOrFallback';
import Home from './pages/Home';
import Courses from './pages/Courses';
import ProductDetail from './pages/ProductDetail';
import Checkout from './pages/Checkout';
import Processing from './pages/Processing';
import AuthCallback from './pages/AuthCallback';
import Admin from './pages/Admin';
import CmsPage from './pages/CmsPage';
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
 */
export default function App() {
  return (
    <BrowserRouter>
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
          <Route path="/admin/*" element={<Admin />} />
          <Route path="/:slug" element={<CmsPage />} />
          <Route path="*" element={<CmsPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

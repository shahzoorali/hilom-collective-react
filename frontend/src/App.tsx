import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Courses from './pages/Courses';
import ProductDetail from './pages/ProductDetail';
import Checkout from './pages/Checkout';
import Processing from './pages/Processing';
import AuthCallback from './pages/AuthCallback';
import Admin from './pages/Admin';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/courses" element={<Courses />} />
          <Route path="/courses/:slug" element={<ProductDetail />} />
          <Route path="/checkout/processing" element={<Processing />} />
          <Route path="/checkout/:slug" element={<Checkout />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

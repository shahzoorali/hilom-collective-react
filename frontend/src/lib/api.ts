import { API_BASE } from '../config';

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_centavos: number;
  currency: string;
  thumbnail_url: string | null;
  image_url: string | null;
}

export interface CourseSummary {
  moodle_course_id: number;
  fullname: string;
  shortname: string;
  summary: string | null;
  content_html: string | null;
  image_url: string | null;
  enrolled_count: number | null;
}

export interface ProductDetail extends Product {
  moodle_course_ids: number[];
  courses: CourseSummary[];
}

export interface AdminOrder {
  id: string;
  paymongo_payment_id: string;
  buyer_email: string;
  amount_centavos: number;
  currency: string;
  status: string;
  moodle_user_id: number | null;
  error_detail: string | null;
  created_at: string;
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const listProducts = () => get<{ products: Product[] }>('/products').then((r) => r.products);

export const getProduct = (slug: string) =>
  get<{ product: ProductDetail }>(`/products/${encodeURIComponent(slug)}`).then((r) => r.product);

export interface CheckoutIntent {
  intentId: string;
  clientKey: string;
  publicKey: string;
  amountCentavos: number;
  currency: string;
  productName: string;
}

export const createIntent = (slug: string, email: string) =>
  get<CheckoutIntent>('/checkout/create-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, email }),
  });

export interface OrderStatus {
  status: 'pending' | 'paid_pending_enrollment' | 'fulfilled' | 'failed' | 'refunded';
  productName: string | null;
  productSlug: string | null;
}

export const getOrderStatus = (paymentId: string) =>
  get<OrderStatus>(`/orders/status/${encodeURIComponent(paymentId)}`);

/**
 * Preferred over getOrderStatus from the browser: PayMongo hides `payments[]`
 * from public-key clients, so the browser knows its intent id but never its
 * payment id. The backend resolves one to the other with the secret key.
 */
export const getOrderStatusByIntent = (intentId: string) =>
  get<OrderStatus>(`/orders/status-by-intent/${encodeURIComponent(intentId)}`);

// --- admin ---

export const adminListOrders = (adminKey: string, status?: string) =>
  get<{ orders: AdminOrder[] }>(`/admin/orders${status ? `?status=${status}` : ''}`, {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.orders);

export const adminSyncCourses = (adminKey: string) =>
  get<{ synced: number; last_synced_at: string | null }>('/admin/sync-courses', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });

export const adminRetryEnrollment = (adminKey: string, orderId: string) =>
  get<{ orderId: string; status: string }>(`/admin/retry-enrollment/${orderId}`, {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });

export interface RevokeResult {
  orderId: string;
  status: string;
  revokedCourseIds: number[];
  /** Courses kept because another live order for this buyer still grants them. */
  retainedCourseIds: number[];
}

export interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_centavos: number;
  currency: string;
  is_active: boolean;
  product_courses: { moodle_course_id: number }[];
}

export const adminListProducts = (adminKey: string) =>
  get<{ products: AdminProduct[] }>('/admin/products', {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.products);

export const adminUpdateProduct = (
  adminKey: string,
  productId: string,
  patch: { price_centavos?: number; is_active?: boolean; name?: string; description?: string },
) =>
  get<{ product: AdminProduct }>(`/admin/products/${productId}`, {
    method: 'PATCH',
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => r.product);

export const adminRevokeAccess = (adminKey: string, orderId: string) =>
  get<RevokeResult>(`/admin/revoke-access/${orderId}`, {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });

export const listCourses = () =>
  get<{ courses: CourseSummary[]; last_synced_at: string | null }>('/courses');

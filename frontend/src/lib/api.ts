import { API_BASE } from '../config';
import { idToken } from './auth';

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
  product_id: string;
  buyer_email: string;
  amount_centavos: number;
  currency: string;
  status: string;
  /** Null when SSO identity was never created — the "logged in but sees nothing" case. */
  cognito_user_sub: string | null;
  moodle_user_id: number | null;
  error_detail: string | null;
  created_at: string;
  /** When the status last changed, which is how long a stuck order has been stuck. */
  updated_at: string;
  product_name: string | null;
  product_slug: string | null;
  /** Courses this sale should have granted — what to check in Moodle. */
  moodle_course_ids: number[];
}

export interface OrderRefund {
  id: string;
  amount_centavos: number | null;
  status: string | null;
  created_at: string | null;
}

export interface OrderPayment {
  id: string;
  status: string | null;
  /** e.g. "gcash", "card", "qrph". Null if PayMongo did not report one. */
  method: string | null;
  amount_centavos: number | null;
  fee_centavos: number | null;
  net_centavos: number | null;
  currency: string | null;
  paid_at: string | null;
  description: string | null;
  billing_name: string | null;
  billing_email: string | null;
  billing_phone: string | null;
  refunds: OrderRefund[];
  refunded_centavos: number;
}

/**
 * Live transaction detail, read from PayMongo at request time rather than from
 * our own tables — fees and refund state change after capture, so a local copy
 * would be stale exactly when support needs it. `available: false` carries a
 * human-readable reason instead of throwing.
 */
export type OrderPaymentResult =
  | { available: true; payment: OrderPayment }
  | { available: false; reason: string };

export const adminGetOrderPayment = (adminKey: string, orderId: string) =>
  apiFetch<OrderPaymentResult>(`/admin/orders/${orderId}/payment`, {
    headers: { 'x-admin-key': adminKey },
  });

/** Shared fetch wrapper: prefixes API_BASE and turns a non-2xx into the
 *  backend's `error` message rather than an opaque status code. Exported so the
 *  CMS client in cms.ts uses the same error handling. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const listProducts = () => apiFetch<{ products: Product[] }>('/products').then((r) => r.products);

export const getProduct = (slug: string) =>
  apiFetch<{ product: ProductDetail }>(`/products/${encodeURIComponent(slug)}`).then((r) => r.product);

export interface CheckoutSession {
  sessionId: string;
  /** PayMongo-hosted page where the buyer actually pays (QRPh QR lives here). */
  checkoutUrl: string;
  amountCentavos: number;
  currency: string;
  productName: string;
}

/**
 * Note there is no `email` parameter: the backend takes the buyer's address
 * from the verified id_token, so the browser cannot name who is being enrolled.
 * `name` is cosmetic — it only labels the PayMongo receipt.
 */
export const createCheckoutSession = (slug: string, name?: string) => {
  const token = idToken();
  if (!token) throw new Error('Sign in to continue');
  return apiFetch<CheckoutSession>('/checkout/create-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug, name }),
  });
};

export interface OrderStatus {
  status: 'pending' | 'paid_pending_enrollment' | 'fulfilled' | 'failed' | 'refunded';
  productName: string | null;
  productSlug: string | null;
  /** Deep link to the purchased course (or /my/ for a bundle). Null until fulfilled. */
  accessUrl: string | null;
}

export const getOrderStatus = (paymentId: string) =>
  apiFetch<OrderStatus>(`/orders/status/${encodeURIComponent(paymentId)}`);

/**
 * Preferred over getOrderStatus from the browser: PayMongo hides `payments[]`
 * from public-key clients, so the browser knows its intent id but never its
 * payment id. The backend resolves one to the other with the secret key.
 */
export const getOrderStatusByIntent = (intentId: string) =>
  apiFetch<OrderStatus>(`/orders/status-by-intent/${encodeURIComponent(intentId)}`);

/**
 * Hosted-checkout equivalent: the browser is redirected back knowing only its
 * checkout session id, so the backend resolves session -> payment id.
 */
export const getOrderStatusBySession = (sessionId: string) =>
  apiFetch<OrderStatus>(`/orders/status-by-session/${encodeURIComponent(sessionId)}`);

export const submitCommunityForm = (body: {
  firstName: string;
  lastName: string;
  email: string;
  interests: string[];
  message: string;
}) =>
  apiFetch<{ sent: boolean }>('/community/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- admin ---

export const adminListOrders = (adminKey: string, status?: string) =>
  apiFetch<{ orders: AdminOrder[] }>(`/admin/orders${status ? `?status=${status}` : ''}`, {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.orders);

export const adminSyncCourses = (adminKey: string) =>
  apiFetch<{ synced: number; last_synced_at: string | null }>('/admin/sync-courses', {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });

export const adminRetryEnrollment = (adminKey: string, orderId: string) =>
  apiFetch<{ orderId: string; status: string }>(`/admin/retry-enrollment/${orderId}`, {
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
  apiFetch<{ products: AdminProduct[] }>('/admin/products', {
    headers: { 'x-admin-key': adminKey },
  }).then((r) => r.products);

export const adminUpdateProduct = (
  adminKey: string,
  productId: string,
  patch: { price_centavos?: number; is_active?: boolean; name?: string; description?: string },
) =>
  apiFetch<{ product: AdminProduct }>(`/admin/products/${productId}`, {
    method: 'PATCH',
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => r.product);

export const adminRevokeAccess = (adminKey: string, orderId: string) =>
  apiFetch<RevokeResult>(`/admin/revoke-access/${orderId}`, {
    method: 'POST',
    headers: { 'x-admin-key': adminKey },
  });

export const listCourses = () =>
  apiFetch<{ courses: CourseSummary[]; last_synced_at: string | null }>('/courses');

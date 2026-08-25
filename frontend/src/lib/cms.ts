/**
 * CMS API client — public reads and admin writes.
 *
 * Kept separate from api.ts, which is commerce-shaped (products, checkout,
 * orders). Both use the same `apiFetch` helper and the same `x-admin-key`
 * header convention as the existing admin calls.
 */
import { apiFetch } from './api';
import type { Block } from '../cms/blocks';

// --- public ---

export interface CmsPage {
  slug: string;
  title: string;
  seo_title: string | null;
  seo_description: string | null;
  blocks: Block[];
  published_at: string | null;
}

export interface MenuLink {
  label: string;
  href: string;
  target: 'self' | 'blank';
  children: MenuLink[];
}

export interface FormFieldDef {
  name: string;
  label: string;
  type: 'text' | 'email' | 'textarea' | 'checkboxGroup' | 'select';
  required: boolean;
  options?: string[];
  help?: string;
  half?: boolean;
}

export interface CmsForm {
  slug: string;
  name: string;
  fields: FormFieldDef[];
  submit_label: string;
  success_message: string;
  requires_captcha: boolean;
}

export interface EventFacilitator {
  name: string;
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  photo_alt: string | null;
}

export interface EventGalleryImage {
  url: string;
  alt: string;
}

export interface CmsEvent {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  image_url: string | null;
  image_alt: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  link_url: string | null;
  link_label: string | null;
  note: string | null;
  /** True when the event sells places on-site rather than linking out. */
  ticketing_enabled?: boolean;
  facilitators?: EventFacilitator[];
  gallery?: EventGalleryImage[];
}

export const getPage = (slug: string) =>
  apiFetch<{ page: CmsPage }>(`/pages/${encodeURIComponent(slug)}`).then((r) => r.page);

export const listPages = () =>
  apiFetch<{ pages: { slug: string; title: string }[] }>('/pages').then((r) => r.pages);

export const getMenus = () =>
  apiFetch<{ menus: Record<string, MenuLink[]> }>('/menus').then((r) => r.menus);

export const getForm = (slug: string) =>
  apiFetch<{ form: CmsForm }>(`/forms/${encodeURIComponent(slug)}`).then((r) => r.form);

export const getEvents = () =>
  apiFetch<{ upcoming: CmsEvent[]; past: CmsEvent[] }>('/events');

export const submitForm = (slug: string, data: Record<string, unknown>) =>
  apiFetch<{ ok: true; message: string }>(`/forms/${encodeURIComponent(slug)}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

// --- admin ---

/**
 * The name the operator typed at sign-in, recorded against money-affecting
 * admin actions in the audit log.
 *
 * This is an attestation, not authentication: the admin key is shared, so
 * anyone holding it can type any name. It is worth sending anyway — an audit
 * row reading "Rina · shared key session · 112.198.x.x" is the difference
 * between a usable reconciliation trail and "someone did this". The admin UI
 * labels it honestly for the same reason.
 */
export const ADMIN_ACTOR_STORAGE = 'hilom.adminActor';

export const adminActor = (): string => sessionStorage.getItem(ADMIN_ACTOR_STORAGE) ?? '';

const adminInit = (adminKey: string, method?: string, body?: unknown): RequestInit => {
  const actor = adminActor();
  return {
    method,
    headers: {
      'x-admin-key': adminKey,
      ...(actor ? { 'x-admin-actor': actor } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
};

/** `trash` and `scheduled` share the enum `published`/`draft` already used
 *  everywhere status is checked — see db/migrations/0009 for why. */
export type AdminContentStatus = 'draft' | 'published' | 'scheduled' | 'trash';

export interface AdminPage {
  id: string;
  slug: string;
  title: string;
  status: AdminContentStatus;
  seo_title: string | null;
  seo_description: string | null;
  is_system: boolean;
  updated_at: string;
  published_at: string | null;
  scheduled_at: string | null;
  deleted_at: string | null;
  /** What to restore to on untrash — only meaningful while status is 'trash'. */
  previous_status: AdminContentStatus | null;
  draft_blocks?: Block[];
  published_blocks?: Block[];
}

export const adminListPages = (adminKey: string) =>
  apiFetch<{ pages: AdminPage[] }>('/admin/pages', adminInit(adminKey)).then((r) => r.pages);

export const adminListTrashedPages = (adminKey: string) =>
  apiFetch<{ pages: AdminPage[] }>('/admin/pages/trash', adminInit(adminKey)).then((r) => r.pages);

export const adminGetPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}`, adminInit(adminKey)).then((r) => r.page);

export const adminCreatePage = (adminKey: string, body: { title: string; slug?: string }) =>
  apiFetch<{ page: AdminPage }>('/admin/pages', adminInit(adminKey, 'POST', body)).then((r) => r.page);

export const adminUpdatePage = (
  adminKey: string,
  pageId: string,
  patch: { title?: string; slug?: string; seo_title?: string; seo_description?: string },
) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}`, adminInit(adminKey, 'PATCH', patch)).then(
    (r) => r.page,
  );

export const adminSaveDraft = (adminKey: string, pageId: string, blocks: Block[]) =>
  apiFetch<{ page: AdminPage }>(
    `/admin/pages/${pageId}/draft`,
    adminInit(adminKey, 'PUT', { blocks }),
  ).then((r) => r.page);

/** `scheduledAt` in the future schedules instead of publishing immediately —
 *  a past/present value (or omitting it) publishes right away. */
export const adminPublishPage = (adminKey: string, pageId: string, scheduledAt?: string) =>
  apiFetch<{ page: AdminPage }>(
    `/admin/pages/${pageId}/publish`,
    adminInit(adminKey, 'POST', scheduledAt ? { scheduledAt } : undefined),
  ).then((r) => r.page);

/** Also cancels a pending schedule — both are "back to draft" server-side. */
export const adminUnpublishPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}/unpublish`, adminInit(adminKey, 'POST')).then(
    (r) => r.page,
  );

/** Moves a page to trash (soft delete) — not the permanent kind. */
export const adminTrashPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}`, adminInit(adminKey, 'DELETE')).then((r) => r.page);

export const adminUntrashPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}/untrash`, adminInit(adminKey, 'POST')).then(
    (r) => r.page,
  );

/** Only valid on a page already in trash — irreversible. */
export const adminPermanentlyDeletePage = (adminKey: string, pageId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/pages/${pageId}/permanent`, adminInit(adminKey, 'DELETE'));

export const adminDuplicatePage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}/duplicate`, adminInit(adminKey, 'POST')).then(
    (r) => r.page,
  );

export interface PageRevision {
  id: string;
  note: string | null;
  created_at: string;
}

export const adminListRevisions = (adminKey: string, pageId: string) =>
  apiFetch<{ revisions: PageRevision[] }>(`/admin/pages/${pageId}/revisions`, adminInit(adminKey)).then(
    (r) => r.revisions,
  );

export const adminRestoreRevision = (adminKey: string, pageId: string, revisionId: string) =>
  apiFetch<{ page: AdminPage }>(
    `/admin/pages/${pageId}/revisions/${revisionId}/restore`,
    adminInit(adminKey, 'POST'),
  ).then((r) => r.page);

export interface AdminMenu {
  key: string;
  label: string;
  items: (MenuLink & { visible: boolean })[];
}

export const adminGetMenus = (adminKey: string) =>
  apiFetch<{ menus: AdminMenu[] }>('/admin/menus', adminInit(adminKey)).then((r) => r.menus);

export const adminSaveMenu = (adminKey: string, key: string, items: unknown[]) =>
  apiFetch<{ menus: AdminMenu[] }>(`/admin/menus/${key}`, adminInit(adminKey, 'PUT', { items })).then(
    (r) => r.menus,
  );

export interface MediaAsset {
  id: string;
  url: string;
  filename: string;
  content_type: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  created_at: string;
}

export const adminListMedia = (adminKey: string, q?: string) =>
  apiFetch<{ media: MediaAsset[] }>(
    `/admin/media${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    adminInit(adminKey),
  ).then((r) => r.media);

export const adminUpdateMedia = (adminKey: string, mediaId: string, alt: string) =>
  apiFetch<{ media: MediaAsset }>(`/admin/media/${mediaId}`, adminInit(adminKey, 'PATCH', { alt })).then(
    (r) => r.media,
  );

export const adminDeleteMedia = (adminKey: string, mediaId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/media/${mediaId}`, adminInit(adminKey, 'DELETE'));

/**
 * Presign → PUT straight to S3 → confirm. The file never passes through the
 * API, so a 10 MB upload doesn't have to fit in a Lambda request body.
 */
export async function adminUploadMedia(adminKey: string, file: File): Promise<MediaAsset> {
  const { uploadUrl, key } = await apiFetch<{ uploadUrl: string; key: string }>(
    '/admin/media/upload-url',
    adminInit(adminKey, 'POST', { filename: file.name, contentType: file.type, bytes: file.size }),
  );

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);

  // S3 has no idea how big the image is in pixels; the browser does, and the
  // library uses it to show sensible thumbnails.
  const dimensions = await measure(file);

  const { media } = await apiFetch<{ media: MediaAsset }>(
    '/admin/media',
    adminInit(adminKey, 'POST', { key, filename: file.name, ...dimensions }),
  );
  return media;
}

async function measure(file: File): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

export interface AdminForm {
  id: string;
  slug: string;
  name: string;
  fields: FormFieldDef[];
  submit_label: string;
  success_message: string;
  notify_email: string | null;
  requires_captcha: boolean;
  submission_count?: number;
}

export interface FormSubmission {
  id: string;
  data: Record<string, unknown>;
  is_spam: boolean;
  created_at: string;
}

export const adminListForms = (adminKey: string) =>
  apiFetch<{ forms: AdminForm[] }>('/admin/forms', adminInit(adminKey)).then((r) => r.forms);

export const adminCreateForm = (adminKey: string, body: { name: string; slug?: string }) =>
  apiFetch<{ form: AdminForm }>('/admin/forms', adminInit(adminKey, 'POST', body)).then((r) => r.form);

export const adminUpdateForm = (adminKey: string, formId: string, patch: Partial<AdminForm>) =>
  apiFetch<{ form: AdminForm }>(`/admin/forms/${formId}`, adminInit(adminKey, 'PUT', patch)).then(
    (r) => r.form,
  );

export const adminListSubmissions = (adminKey: string, formId: string) =>
  apiFetch<{ submissions: FormSubmission[] }>(
    `/admin/forms/${formId}/submissions`,
    adminInit(adminKey),
  ).then((r) => r.submissions);

export const adminDeleteSubmission = (adminKey: string, formId: string, submissionId: string) =>
  apiFetch<{ deleted: boolean }>(
    `/admin/forms/${formId}/submissions/${submissionId}`,
    adminInit(adminKey, 'DELETE'),
  );

export interface AdminEvent extends CmsEvent {
  image_id: string | null;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  facilitators: EventFacilitator[];
  gallery: EventGalleryImage[];
  // Ticketing (migration 0016). Null/false on every listing-only event, which
  // is every event that existed before ticketing shipped.
  ticketing_enabled: boolean;
  format: EventFormat | null;
  capacity: number | null;
  currency: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  hold_minutes: number;
  venue_details: string | null;
  terms_html: string | null;
  registrant_fields: string[];
}

export type EventFormat = 'residential' | 'virtual' | 'day';
export type PaymentPlanKind = 'full' | 'installment';

/** Fields an event may ask a registrant for, beyond name/email/phone. */
export const REGISTRANT_FIELDS = [
  'dietary',
  'emergency_contact',
  'emergency_phone',
  'room_preference',
  'medical_notes',
  'accessibility_needs',
  'pronouns',
  'how_did_you_hear',
] as const;

export const REGISTRANT_FIELD_LABELS: Record<string, string> = {
  dietary: 'Dietary requirements',
  emergency_contact: 'Emergency contact name',
  emergency_phone: 'Emergency contact number',
  room_preference: 'Room preference',
  medical_notes: 'Medical notes',
  accessibility_needs: 'Accessibility needs',
  pronouns: 'Pronouns',
  how_did_you_hear: 'How did you hear about us?',
};

export interface AdminInstallment {
  id?: string;
  seq: number;
  label: string;
  amount_centavos: number;
  /** Absolute due date as a Manila calendar day. Null for the deposit. */
  due_at: string | null;
  due_offset_days: number | null;
  is_deposit: boolean;
}

export interface AdminPlan {
  id?: string;
  name: string;
  description: string | null;
  kind: PaymentPlanKind;
  total_centavos: number;
  currency: string;
  available_from: string | null;
  available_until: string | null;
  is_active: boolean;
  sort_order: number;
  installments: AdminInstallment[];
  /** Read-only, returned by the API: how many people are on this plan. */
  registration_count?: number;
  /** True once anyone has registered — money and schedule become immutable. */
  schedule_locked?: boolean;
}

/** The write shape: image travels as one {id,url,alt} object (same MediaRef
 *  every media field uses), not the three flattened columns the read shape
 *  returns — the backend's validateEvent expects `image`, not `image_url`. */
export type AdminEventInput = {
  title: string;
  subtitle?: string;
  description?: string;
  image?: { id: string; url: string; alt: string };
  location?: string;
  starts_at: string;
  ends_at?: string;
  link_url?: string;
  link_label?: string;
  note?: string;
  status?: 'draft' | 'published';
  // Ticketing. Omitted entirely by the listing-only form; the backend's
  // validateTicketing returns null when none of these keys are present, so a
  // save from that form cannot clear a configured event's capacity.
  ticketing_enabled?: boolean;
  format?: EventFormat | null;
  capacity?: number | null;
  registration_opens_at?: string | null;
  registration_closes_at?: string | null;
  hold_minutes?: number;
  venue_details?: string | null;
  terms_html?: string | null;
  registrant_fields?: string[];
  facilitators?: EventFacilitator[];
  gallery?: EventGalleryImage[];
};

export const adminListEvents = (adminKey: string) =>
  apiFetch<{ events: AdminEvent[] }>('/admin/events', adminInit(adminKey)).then((r) => r.events);

export const adminCreateEvent = (adminKey: string, input: AdminEventInput) =>
  apiFetch<{ event: AdminEvent }>('/admin/events', adminInit(adminKey, 'POST', input)).then((r) => r.event);

export const adminUpdateEvent = (adminKey: string, eventId: string, input: AdminEventInput) =>
  apiFetch<{ event: AdminEvent }>(
    `/admin/events/${eventId}`,
    adminInit(adminKey, 'PUT', input),
  ).then((r) => r.event);

export const adminDeleteEvent = (adminKey: string, eventId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/events/${eventId}`, adminInit(adminKey, 'DELETE'));

export const adminGetEventPlans = (adminKey: string, eventId: string) =>
  apiFetch<{ plans: AdminPlan[] }>(
    `/admin/events/${eventId}/plans`,
    adminInit(adminKey),
  ).then((r) => r.plans);

/**
 * Writes the whole plan set at once.
 *
 * Not a per-plan endpoint: the database's totals trigger is deferred to commit,
 * so a schedule has to arrive complete or it never adds up. See
 * replace_event_plans in migration 0017.
 */
export const adminReplaceEventPlans = (adminKey: string, eventId: string, plans: AdminPlan[]) =>
  apiFetch<{ plans: AdminPlan[] }>(
    `/admin/events/${eventId}/plans`,
    adminInit(adminKey, 'PUT', { plans }),
  ).then((r) => r.plans);

// --- blog (public) ---

export interface BlogCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
}

export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  image_url: string | null;
  image_alt: string | null;
  author_name: string | null;
  author_image_url: string | null;
  category_id: string | null;
  categories: { slug: string; name: string } | null;
  tags: string[];
  published_at: string;
}

export interface BlogPostDetail extends BlogPost {
  blocks: Block[];
  seo_title: string | null;
  seo_description: string | null;
}

export interface BlogListResponse {
  posts: BlogPost[];
  total: number;
  page: number;
  pageSize: number;
}

export const getPosts = (params?: { page?: number; category?: string; tag?: string }) => {
  const search = new URLSearchParams();
  if (params?.page && params.page > 1) search.set('page', String(params.page));
  if (params?.category) search.set('category', params.category);
  if (params?.tag) search.set('tag', params.tag);
  const qs = search.toString();
  return apiFetch<BlogListResponse>(`/posts${qs ? `?${qs}` : ''}`);
};

export const getPost = (slug: string) =>
  apiFetch<{ post: BlogPostDetail; related: BlogPost[] }>(`/posts/${encodeURIComponent(slug)}`);

export const getCategories = () =>
  apiFetch<{ categories: BlogCategory[] }>('/categories').then((r) => r.categories);

// --- blog (admin) ---

export interface AdminPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  image_id: string | null;
  image_url: string | null;
  image_alt: string | null;
  author_name: string | null;
  author_image_url: string | null;
  category_id: string | null;
  categories?: { slug: string; name: string } | null;
  tags: string[];
  seo_title: string | null;
  seo_description: string | null;
  status: AdminContentStatus;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  scheduled_at: string | null;
  deleted_at: string | null;
  /** What to restore to on untrash — only meaningful while status is 'trash'. */
  previous_status: AdminContentStatus | null;
  draft_blocks?: Block[];
  published_blocks?: Block[];
}

export const adminListPosts = (adminKey: string) =>
  apiFetch<{ posts: AdminPost[] }>('/admin/posts', adminInit(adminKey)).then((r) => r.posts);

export const adminListTrashedPosts = (adminKey: string) =>
  apiFetch<{ posts: AdminPost[] }>('/admin/posts/trash', adminInit(adminKey)).then((r) => r.posts);

export const adminGetPost = (adminKey: string, postId: string) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}`, adminInit(adminKey)).then((r) => r.post);

export const adminCreatePost = (adminKey: string, body: { title: string; slug?: string }) =>
  apiFetch<{ post: AdminPost }>('/admin/posts', adminInit(adminKey, 'POST', body)).then((r) => r.post);

export const adminUpdatePost = (
  adminKey: string,
  postId: string,
  patch: Record<string, unknown>,
) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}`, adminInit(adminKey, 'PATCH', patch)).then(
    (r) => r.post,
  );

export const adminSavePostDraft = (adminKey: string, postId: string, blocks: Block[]) =>
  apiFetch<{ post: AdminPost }>(
    `/admin/posts/${postId}/draft`,
    adminInit(adminKey, 'PUT', { blocks }),
  ).then((r) => r.post);

/** `scheduledAt` in the future schedules instead of publishing immediately —
 *  a past/present value (or omitting it) publishes right away. */
export const adminPublishPost = (adminKey: string, postId: string, scheduledAt?: string) =>
  apiFetch<{ post: AdminPost }>(
    `/admin/posts/${postId}/publish`,
    adminInit(adminKey, 'POST', scheduledAt ? { scheduledAt } : undefined),
  ).then((r) => r.post);

/** Also cancels a pending schedule — both are "back to draft" server-side. */
export const adminUnpublishPost = (adminKey: string, postId: string) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}/unpublish`, adminInit(adminKey, 'POST')).then(
    (r) => r.post,
  );

/** Moves a post to trash (soft delete) — not the permanent kind. */
export const adminTrashPost = (adminKey: string, postId: string) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}`, adminInit(adminKey, 'DELETE')).then((r) => r.post);

export const adminUntrashPost = (adminKey: string, postId: string) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}/untrash`, adminInit(adminKey, 'POST')).then(
    (r) => r.post,
  );

/** Only valid on a post already in trash — irreversible. */
export const adminPermanentlyDeletePost = (adminKey: string, postId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/posts/${postId}/permanent`, adminInit(adminKey, 'DELETE'));

export const adminDuplicatePost = (adminKey: string, postId: string) =>
  apiFetch<{ post: AdminPost }>(`/admin/posts/${postId}/duplicate`, adminInit(adminKey, 'POST')).then(
    (r) => r.post,
  );

export interface PostRevision {
  id: string;
  note: string | null;
  created_at: string;
}

export const adminListPostRevisions = (adminKey: string, postId: string) =>
  apiFetch<{ revisions: PostRevision[] }>(`/admin/posts/${postId}/revisions`, adminInit(adminKey)).then(
    (r) => r.revisions,
  );

export const adminRestorePostRevision = (adminKey: string, postId: string, revisionId: string) =>
  apiFetch<{ post: AdminPost }>(
    `/admin/posts/${postId}/revisions/${revisionId}/restore`,
    adminInit(adminKey, 'POST'),
  ).then((r) => r.post);

// --- categories (admin) ---

export interface AdminCategory extends BlogCategory {
  created_at: string;
  updated_at: string;
}

export const adminListCategories = (adminKey: string) =>
  apiFetch<{ categories: AdminCategory[] }>('/admin/categories', adminInit(adminKey)).then((r) => r.categories);

export const adminCreateCategory = (adminKey: string, body: { name: string; slug?: string; description?: string; position?: number }) =>
  apiFetch<{ category: AdminCategory }>('/admin/categories', adminInit(adminKey, 'POST', body)).then((r) => r.category);

export const adminUpdateCategory = (adminKey: string, categoryId: string, body: { name: string; slug?: string; description?: string; position?: number }) =>
  apiFetch<{ category: AdminCategory }>(`/admin/categories/${categoryId}`, adminInit(adminKey, 'PATCH', body)).then((r) => r.category);

export const adminDeleteCategory = (adminKey: string, categoryId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/categories/${categoryId}`, adminInit(adminKey, 'DELETE'));

// --- event registrations (admin) ---

export type AdminChargeStatus =
  | 'scheduled'
  | 'awaiting_payment'
  | 'paid'
  | 'waived'
  | 'void'
  | 'refunded';

export interface AdminCharge {
  id: string;
  registration_id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: AdminChargeStatus;
  paid_at: string | null;
  paid_method: string | null;
  paid_reference: string | null;
  receipt_no: string | null;
  flagged_at: string | null;
  void_reason: string | null;
  paymongo_payment_id: string | null;
}

export interface AdminRegistration {
  id: string;
  event_id: string;
  status: 'pending_payment' | 'confirmed' | 'expired' | 'cancelled' | 'completed';
  seat_no: number;
  buyer_email: string;
  registrant_name: string;
  registrant_email: string;
  registrant_phone: string | null;
  registrant_details: Record<string, string>;
  plan_name: string;
  plan_kind: 'full' | 'installment';
  total_centavos: number;
  currency: string;
  confirmed_at: string | null;
  flagged_at: string | null;
  flag_reason: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  cancellation_decided_at: string | null;
  cancelled_at: string | null;
  refund_centavos: number | null;
  refunded_at: string | null;
  admin_notes: string | null;
  created_at: string;
  charges: AdminCharge[];
  paidCentavos: number;
  outstandingCentavos: number;
  overdueCentavos: number;
  overdueCount: number;
  nextDue: AdminCharge | null;
  events?: { title: string; starts_at: string; ends_at: string | null; location: string | null } | null;
}

export interface RosterMoney {
  currency: string;
  capacity: number;
  placesTaken: number;
  placesFree: number;
  collectedCentavos: number;
  outstandingCentavos: number;
  overdueCentavos: number;
  expectedCentavos: number;
  cancelledPaidCentavos: number;
  refundsOwedCentavos: number;
}

export interface AuditEntry {
  id: string;
  actor_source: 'shared_key' | 'cognito' | 'system';
  actor_label: string;
  source_ip: string | null;
  action: string;
  target_table: string;
  target_id: string | null;
  event_id: string | null;
  amount_centavos: number | null;
  currency: string | null;
  note: string | null;
  created_at: string;
}

export const adminGetRoster = (adminKey: string, eventId: string) =>
  apiFetch<{ event: AdminEvent; registrations: AdminRegistration[]; money: RosterMoney }>(
    `/admin/events/${eventId}/roster`,
    adminInit(adminKey),
  );

export const adminListRegistrations = (adminKey: string, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch<{ registrations: AdminRegistration[] }>(
    `/admin/registrations${qs ? `?${qs}` : ''}`,
    adminInit(adminKey),
  ).then((r) => r.registrations);
};

export const adminGetRegistration = (adminKey: string, registrationId: string) =>
  apiFetch<{ registration: AdminRegistration; audit: AuditEntry[] }>(
    `/admin/registrations/${registrationId}`,
    adminInit(adminKey),
  );

export const adminMarkChargePaid = (
  adminKey: string,
  registrationId: string,
  chargeId: string,
  body: { method: string; reference: string; paidAt?: string },
) =>
  apiFetch<{ chargeId: string; status: string }>(
    `/admin/registrations/${registrationId}/charges/${chargeId}/mark-paid`,
    adminInit(adminKey, 'POST', body),
  );

export const adminSettleChargeWithout = (
  adminKey: string,
  registrationId: string,
  chargeId: string,
  outcome: 'waive' | 'void',
  reason: string,
) =>
  apiFetch<{ chargeId: string; status: string }>(
    `/admin/registrations/${registrationId}/charges/${chargeId}/${outcome}`,
    adminInit(adminKey, 'POST', { reason }),
  );

export const adminCancelRegistration = (
  adminKey: string,
  registrationId: string,
  body: { reason?: string; refundCentavos?: number | null },
) =>
  apiFetch<{ registrationId: string; status: string; seatFreed: number }>(
    `/admin/registrations/${registrationId}/cancel`,
    adminInit(adminKey, 'POST', body),
  );

export const adminNudgeRegistration = (adminKey: string, registrationId: string, note?: string) =>
  apiFetch<{ registrationId: string; sent: boolean }>(
    `/admin/registrations/${registrationId}/nudge`,
    adminInit(adminKey, 'POST', { note }),
  );

export const adminListAuditLog = (adminKey: string, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch<{ entries: AuditEntry[] }>(
    `/admin/audit-log${qs ? `?${qs}` : ''}`,
    adminInit(adminKey),
  ).then((r) => r.entries);
};

/** The CSV export is a download, so it bypasses apiFetch and its JSON parsing. */
export const adminRosterCsvUrl = (eventId: string) => `/admin/events/${eventId}/roster.csv`;

export const adminDecideCancellation = (
  adminKey: string,
  registrationId: string,
  body: { decision: 'approved' | 'declined'; reason?: string; refundCentavos?: number | null },
) =>
  apiFetch<{ registrationId: string; decision: string }>(
    `/admin/registrations/${registrationId}/cancellation-decision`,
    adminInit(adminKey, 'POST', body),
  );

/** Records that a refund actually moved — separate from deciding its amount. */
export const adminMarkRefundSent = (adminKey: string, registrationId: string, reference: string) =>
  apiFetch<{ registrationId: string; refundedAt: string; reference: string }>(
    `/admin/registrations/${registrationId}/refund-sent`,
    adminInit(adminKey, 'POST', { reference }),
  );

export const adminOverridePrice = (
  adminKey: string,
  registrationId: string,
  body: { totalCentavos: number; reason: string },
) =>
  apiFetch<{
    registrationId: string;
    totalCentavos: number;
    paidCentavos: number;
    overpaidCentavos: number;
  }>(`/admin/registrations/${registrationId}/price-override`, adminInit(adminKey, 'POST', body));

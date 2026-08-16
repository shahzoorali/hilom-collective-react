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
}

export const getPage = (slug: string) =>
  apiFetch<{ page: CmsPage }>(`/pages/${encodeURIComponent(slug)}`).then((r) => r.page);

export const listPages = () =>
  apiFetch<{ pages: { slug: string; title: string }[] }>('/pages').then((r) => r.pages);

export const getMenus = () =>
  apiFetch<{ menus: Record<string, MenuLink[]> }>('/menus').then((r) => r.menus);

export const getForm = (slug: string) =>
  apiFetch<{ form: CmsForm }>(`/forms/${encodeURIComponent(slug)}`).then((r) => r.form);

export const submitForm = (slug: string, data: Record<string, unknown>) =>
  apiFetch<{ ok: true; message: string }>(`/forms/${encodeURIComponent(slug)}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

// --- admin ---

const adminInit = (adminKey: string, method?: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'x-admin-key': adminKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

export interface AdminPage {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  seo_title: string | null;
  seo_description: string | null;
  is_system: boolean;
  updated_at: string;
  published_at: string | null;
  draft_blocks?: Block[];
  published_blocks?: Block[];
}

export const adminListPages = (adminKey: string) =>
  apiFetch<{ pages: AdminPage[] }>('/admin/pages', adminInit(adminKey)).then((r) => r.pages);

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

export const adminPublishPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}/publish`, adminInit(adminKey, 'POST')).then(
    (r) => r.page,
  );

export const adminUnpublishPage = (adminKey: string, pageId: string) =>
  apiFetch<{ page: AdminPage }>(`/admin/pages/${pageId}/unpublish`, adminInit(adminKey, 'POST')).then(
    (r) => r.page,
  );

export const adminDeletePage = (adminKey: string, pageId: string) =>
  apiFetch<{ deleted: boolean }>(`/admin/pages/${pageId}`, adminInit(adminKey, 'DELETE'));

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

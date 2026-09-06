/**
 * Knowledge base API client — public reads and admin writes.
 *
 * Kept out of cms.ts for the same reason cms.ts is kept out of api.ts: that
 * file is already 1100 lines covering pages, posts, menus, media, forms and
 * events, and the KB shares none of its types. Same `apiFetch` helper and the
 * same `x-admin-key` header convention.
 */
import { apiFetch } from './api';
import { adminActor } from './cms';

// ---------------------------------------------------------------------------
// Shared types — these mirror the columns in 0037_knowledge_base.sql.
// ---------------------------------------------------------------------------

export type ArticleKind = 'guide' | 'troubleshooting';
export type Audience = 'client' | 'facilitator' | 'both';
export type ArticleStatus = 'draft' | 'published';

export const ARTICLE_KINDS: ArticleKind[] = ['guide', 'troubleshooting'];
export const AUDIENCES: Audience[] = ['client', 'facilitator', 'both'];

export const AUDIENCE_LABELS: Record<Audience, string> = {
  client: 'Clients',
  facilitator: 'Facilitators',
  both: 'Everyone',
};

export const KIND_LABELS: Record<ArticleKind, string> = {
  guide: 'Guide',
  troubleshooting: 'Troubleshooting',
};

export interface KbCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  position: number;
  created_at?: string;
  updated_at?: string;
  /** Only present on the public listing. */
  article_count?: number;
}

export interface KbArticle {
  id: string;
  slug: string;
  category_id: string;
  title: string;
  summary: string | null;
  kind: ArticleKind;
  audience: Audience;
  position: number;
  tags: string[];
  seo_title: string | null;
  seo_description: string | null;
  status: ArticleStatus;
  published_at: string | null;
  helpful_yes: number;
  created_at: string;
  updated_at: string;
  /** Only returned by the single-article read, never by the list. */
  body?: string;
  /** The joined category, when the endpoint selected it. */
  kb_categories?: { slug: string; name: string; position?: number } | null;
}

export interface KbRevision {
  id: string;
  note: string | null;
  created_at: string;
}

export interface ArticlePatch {
  title?: string;
  slug?: string;
  category_id?: string;
  summary?: string | null;
  body?: string;
  kind?: ArticleKind;
  audience?: Audience;
  position?: number;
  tags?: string[];
  seo_title?: string | null;
  seo_description?: string | null;
}

export interface CategoryInput {
  name: string;
  slug?: string;
  description?: string | null;
  icon?: string | null;
  position?: number;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

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

export const adminListKbCategories = (adminKey: string) =>
  apiFetch<{ categories: KbCategory[] }>('/admin/kb/categories', adminInit(adminKey)).then(
    (r) => r.categories,
  );

export const adminCreateKbCategory = (adminKey: string, body: CategoryInput) =>
  apiFetch<{ category: KbCategory }>('/admin/kb/categories', adminInit(adminKey, 'POST', body)).then(
    (r) => r.category,
  );

export const adminUpdateKbCategory = (adminKey: string, categoryId: string, body: CategoryInput) =>
  apiFetch<{ category: KbCategory }>(
    `/admin/kb/categories/${categoryId}`,
    adminInit(adminKey, 'PATCH', body),
  ).then((r) => r.category);

export const adminDeleteKbCategory = (adminKey: string, categoryId: string) =>
  apiFetch<{ deleted: true }>(`/admin/kb/categories/${categoryId}`, adminInit(adminKey, 'DELETE'));

export const adminListKbArticles = (adminKey: string) =>
  apiFetch<{ articles: KbArticle[] }>('/admin/kb/articles', adminInit(adminKey)).then(
    (r) => r.articles,
  );

export const adminGetKbArticle = (adminKey: string, articleId: string) =>
  apiFetch<{ article: KbArticle }>(`/admin/kb/articles/${articleId}`, adminInit(adminKey)).then(
    (r) => r.article,
  );

export const adminCreateKbArticle = (
  adminKey: string,
  body: { title: string; category_id: string; slug?: string; kind?: ArticleKind; audience?: Audience },
) =>
  apiFetch<{ article: KbArticle }>('/admin/kb/articles', adminInit(adminKey, 'POST', body)).then(
    (r) => r.article,
  );

export const adminUpdateKbArticle = (adminKey: string, articleId: string, patch: ArticlePatch) =>
  apiFetch<{ article: KbArticle }>(
    `/admin/kb/articles/${articleId}`,
    adminInit(adminKey, 'PATCH', patch),
  ).then((r) => r.article);

export const adminDeleteKbArticle = (adminKey: string, articleId: string) =>
  apiFetch<{ deleted: true }>(`/admin/kb/articles/${articleId}`, adminInit(adminKey, 'DELETE'));

export const adminPublishKbArticle = (adminKey: string, articleId: string) =>
  apiFetch<{ article: KbArticle }>(
    `/admin/kb/articles/${articleId}/publish`,
    adminInit(adminKey, 'POST'),
  ).then((r) => r.article);

export const adminUnpublishKbArticle = (adminKey: string, articleId: string) =>
  apiFetch<{ article: KbArticle }>(
    `/admin/kb/articles/${articleId}/unpublish`,
    adminInit(adminKey, 'POST'),
  ).then((r) => r.article);

export const adminListKbRevisions = (adminKey: string, articleId: string) =>
  apiFetch<{ revisions: KbRevision[] }>(
    `/admin/kb/articles/${articleId}/revisions`,
    adminInit(adminKey),
  ).then((r) => r.revisions);

export const adminRestoreKbRevision = (adminKey: string, articleId: string, revisionId: string) =>
  apiFetch<{ article: KbArticle }>(
    `/admin/kb/articles/${articleId}/revisions/${revisionId}/restore`,
    adminInit(adminKey, 'POST'),
  ).then((r) => r.article);

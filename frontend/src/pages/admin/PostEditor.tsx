/**
 * Post editor — wraps BlockEditor with post-specific metadata fields.
 *
 * The block editor (Puck canvas) is the same component pages use; this
 * wrapper adds the fields that make a post a post: excerpt, cover image,
 * byline, category, tags, and SEO overrides.
 */
import { useEffect, useMemo, useState } from 'react';
import BlockEditor, { type EditorAdapter } from './BlockEditor';
import MediaField from './MediaField';
import TextListField from './TextListField';
import type { MediaRef } from '../../cms/blocks';
import {
  adminGetPost,
  adminSavePostDraft,
  adminPublishPost,
  adminUnpublishPost,
  adminListPostRevisions,
  adminRestorePostRevision,
  adminUpdatePost,
  adminListCategories,
  type AdminPost,
  type AdminCategory,
} from '../../lib/cms';

function usePostsAdapter(adminKey: string): EditorAdapter<AdminPost> {
  return useMemo(
    () => ({
      label: 'post',
      load: (postId) => adminGetPost(adminKey, postId),
      saveDraft: (postId, blocks) => adminSavePostDraft(adminKey, postId, blocks),
      publish: (postId) => adminPublishPost(adminKey, postId),
      unpublish: (postId) => adminUnpublishPost(adminKey, postId),
      listRevisions: (postId) => adminListPostRevisions(adminKey, postId),
      restoreRevision: (postId, revisionId) =>
        adminRestorePostRevision(adminKey, postId, revisionId),
      headerTitle: (post) => `${post.title} — /blog/${post.slug}`,
      publishNotice: 'Publishing — live in a couple of minutes.',
    }),
    [adminKey],
  );
}

export default function PostEditor({
  adminKey,
  postId,
  onBack,
}: {
  adminKey: string;
  postId: string;
  onBack: () => void;
}) {
  const adapter = usePostsAdapter(adminKey);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showMeta, setShowMeta] = useState(true);

  // Local state for metadata fields.
  const [excerpt, setExcerpt] = useState('');
  const [image, setImage] = useState<MediaRef | undefined>();
  const [authorName, setAuthorName] = useState('');
  const [authorImageUrl, setAuthorImageUrl] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');

  useEffect(() => {
    adminGetPost(adminKey, postId).then((p) => {
      setExcerpt(p.excerpt ?? '');
      setImage(
        p.image_url ? { id: p.image_id ?? '', url: p.image_url, alt: p.image_alt ?? '' } : undefined,
      );
      setAuthorName(p.author_name ?? '');
      setAuthorImageUrl(p.author_image_url ?? '');
      setCategoryId(p.category_id ?? '');
      setTags(p.tags);
      setSeoTitle(p.seo_title ?? '');
      setSeoDescription(p.seo_description ?? '');
    });
    adminListCategories(adminKey).then(setCategories).catch(() => {});
  }, [adminKey, postId]);

  async function saveMeta() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await adminUpdatePost(adminKey, postId, {
        excerpt: excerpt || null,
        image: image ? { id: image.id, url: image.url, alt: image.alt } : null,
        author_name: authorName || null,
        author_image_url: authorImageUrl || null,
        category_id: categoryId || null,
        tags,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
      });
      setNotice('Metadata saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Collapsible metadata panel above the block editor */}
      <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--line)' }}>
        <button
          className="btn btn-ghost small"
          onClick={() => setShowMeta((s) => !s)}
          style={{ marginBottom: showMeta ? '0.5rem' : 0 }}
        >
          {showMeta ? '▾ Post metadata' : '▸ Post metadata'}
        </button>

        {showMeta && (
          <div className="panel" style={{ marginBottom: '0.5rem' }}>
            {error && <div className="alert alert-error">{error}</div>}
            {notice && <div className="alert alert-success">{notice}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="field">
                <label>Excerpt</label>
                <textarea
                  rows={2}
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  placeholder="Short summary for cards and SEO…"
                />
              </div>

              <div className="field">
                <label>Cover image</label>
                <MediaField
                  adminKey={adminKey}
                  value={image}
                  onChange={(v) => setImage(v as MediaRef | undefined)}
                />
              </div>

              <div className="field">
                <label>Author name</label>
                <input value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
              </div>

              <div className="field">
                <label>Author photo URL</label>
                <input
                  value={authorImageUrl}
                  onChange={(e) => setAuthorImageUrl(e.target.value)}
                  placeholder="https://…"
                />
              </div>

              <div className="field">
                <label>Category</label>
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">None</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>Tags</label>
                <TextListField
                  value={tags}
                  onChange={(v) => setTags(v as string[])}
                  itemLabel="tag"
                />
              </div>

              <div className="field">
                <label>SEO title</label>
                <input
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  placeholder="Override for search engines"
                />
              </div>

              <div className="field">
                <label>SEO description</label>
                <textarea
                  rows={2}
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  placeholder="Override for search engines"
                />
              </div>
            </div>

            <button className="btn btn-primary small" onClick={saveMeta} disabled={busy}>
              Save metadata
            </button>
          </div>
        )}
      </div>

      {/* Block editor fills the rest */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <BlockEditor
          adminKey={adminKey}
          resourceId={postId}
          adapter={adapter}
          onBack={onBack}
          backLabel="All posts"
        />
      </div>
    </div>
  );
}

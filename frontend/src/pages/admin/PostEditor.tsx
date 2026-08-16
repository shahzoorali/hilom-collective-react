/**
 * Post editor — wraps BlockEditor with a slide-over Post Settings drawer.
 *
 * This design ensures the Puck canvas has 100% full viewport height for
 * frictionless, unhindered block dragging and canvas scrolling, while all
 * metadata (excerpt, cover image, byline, category, interactive tags, and
 * live SERP / Social preview mockups) live in a sleek slide-over drawer.
 */
import { useEffect, useMemo, useState } from 'react';
import BlockEditor, { type EditorAdapter } from './BlockEditor';
import MediaField from './MediaField';
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
  adminCreateCategory,
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
      viewUrl: (post) => `/blog/${post.slug}`,
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'general' | 'media' | 'tags' | 'seo'>('general');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [image, setImage] = useState<MediaRef | undefined>();
  const [authorName, setAuthorName] = useState('');
  const [authorImageUrl, setAuthorImageUrl] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');

  // Inline Category Creation
  const [newCatName, setNewCatName] = useState('');
  const [creatingCat, setCreatingCat] = useState(false);

  const loadData = () => {
    adminGetPost(adminKey, postId).then((p) => {
      setTitle(p.title);
      setSlug(p.slug);
      setExcerpt(p.excerpt ?? '');
      setImage(
        p.image_url ? { id: p.image_id ?? '', url: p.image_url, alt: p.image_alt ?? '' } : undefined,
      );
      setAuthorName(p.author_name ?? '');
      setAuthorImageUrl(p.author_image_url ?? '');
      setCategoryId(p.category_id ?? '');
      setTags(p.tags || []);
      setSeoTitle(p.seo_title ?? '');
      setSeoDescription(p.seo_description ?? '');
    });
    adminListCategories(adminKey).then(setCategories).catch(() => {});
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey, postId]);

  // Handle Tag Input
  function handleAddTag() {
    const trimmed = tagInput.trim().replace(/^#/, '');
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput('');
  }

  function handleRemoveTag(tagToRemove: string) {
    setTags(tags.filter((t) => t !== tagToRemove));
  }

  // Handle Quick Category Create
  async function handleCreateCategory() {
    if (!newCatName.trim()) return;
    setCreatingCat(true);
    try {
      const created = await adminCreateCategory(adminKey, { name: newCatName.trim() });
      setCategories((prev) => [...prev, created]);
      setCategoryId(created.id);
      setNewCatName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingCat(false);
    }
  }

  // Save Post Settings
  async function handleSaveSettings() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await adminUpdatePost(adminKey, postId, {
        title: title.trim() || undefined,
        slug: slug.trim() || undefined,
        excerpt: excerpt || null,
        image: image ? { id: image.id, url: image.url, alt: image.alt } : null,
        author_name: authorName || null,
        author_image_url: authorImageUrl || null,
        category_id: categoryId || null,
        tags,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
      });
      setNotice('Post settings updated successfully.');
      setTimeout(() => setNotice(null), 3500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Live SERP & Social Preview Computations
  const effectiveTitle = seoTitle.trim() || title.trim() || 'Blog Post Title';
  const effectiveDescription =
    seoDescription.trim() ||
    excerpt.trim() ||
    'Read insights, practices, and stories on holistic healing and well-being from Hilom Collective.';
  const effectiveUrl = `https://www.hilomcollective.com/blog/${slug || 'post-slug'}`;

  return (
    <BlockEditor
      adminKey={adminKey}
      resourceId={postId}
      adapter={adapter}
      onBack={onBack}
      backLabel="All posts"
      renderExtraHeaderActions={() => (
        <button
          className="btn btn-ghost small"
          onClick={() => setDrawerOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600 }}
          title="Edit post metadata, cover, author & SEO"
        >
          ⚙️ Settings
        </button>
      )}
    >
      {/* Slide-over Post Settings Drawer */}
      {drawerOpen && (
        <div className="admin-drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <div className="admin-drawer" onClick={(e) => e.stopPropagation()}>
            {/* Drawer Header */}
            <div className="admin-drawer-header">
              <h2>Post Settings</h2>
              <button
                className="btn btn-ghost small"
                onClick={() => setDrawerOpen(false)}
                style={{ fontSize: '1.1rem', padding: '0.2rem 0.5rem' }}
                title="Close settings"
              >
                ✕
              </button>
            </div>

            {/* Drawer Tabs */}
            <div className="admin-drawer-tabs">
              <button
                className={`admin-drawer-tab ${activeTab === 'general' ? 'admin-drawer-tab--active' : ''}`}
                onClick={() => setActiveTab('general')}
              >
                📝 General
              </button>
              <button
                className={`admin-drawer-tab ${activeTab === 'media' ? 'admin-drawer-tab--active' : ''}`}
                onClick={() => setActiveTab('media')}
              >
                🖼️ Media & Author
              </button>
              <button
                className={`admin-drawer-tab ${activeTab === 'tags' ? 'admin-drawer-tab--active' : ''}`}
                onClick={() => setActiveTab('tags')}
              >
                🏷️ Tags ({tags.length})
              </button>
              <button
                className={`admin-drawer-tab ${activeTab === 'seo' ? 'admin-drawer-tab--active' : ''}`}
                onClick={() => setActiveTab('seo')}
              >
                🔍 SEO & Social
              </button>
            </div>

            {/* Drawer Body */}
            <div className="admin-drawer-body">
              {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}
              {notice && <div className="alert alert-success" style={{ marginBottom: '1rem' }}>{notice}</div>}

              {/* TAB 1: GENERAL */}
              {activeTab === 'general' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="field">
                    <label>Post Title</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Title of your post"
                    />
                  </div>

                  <div className="field">
                    <label>URL Slug</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span className="small muted">/blog/</span>
                      <input
                        type="text"
                        style={{ flex: 1 }}
                        value={slug}
                        onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                        placeholder="custom-post-slug"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label>Category</label>
                    <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                      <option value="">None (Uncategorized)</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>

                    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                      <input
                        type="text"
                        placeholder="Add new category"
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        style={{ fontSize: '0.85rem' }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost small"
                        onClick={handleCreateCategory}
                        disabled={creatingCat || !newCatName.trim()}
                      >
                        {creatingCat ? 'Adding…' : '+ Add'}
                      </button>
                    </div>
                  </div>

                  <div className="field">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label>Excerpt / Summary</label>
                      <span className="small muted">{excerpt.length} / 160 chars</span>
                    </div>
                    <textarea
                      rows={3}
                      value={excerpt}
                      onChange={(e) => setExcerpt(e.target.value)}
                      placeholder="A compelling 1-2 sentence summary displayed on card grids, RSS, and social embeds…"
                    />
                  </div>
                </div>
              )}

              {/* TAB 2: MEDIA & AUTHOR */}
              {activeTab === 'media' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div className="field">
                    <label>Featured Cover Image</label>
                    <p className="small muted" style={{ marginTop: 0 }}>
                      Used as the header image on the post page and in social share cards (16:9 ratio recommended).
                    </p>
                    <MediaField
                      adminKey={adminKey}
                      value={image}
                      onChange={(v) => setImage(v as MediaRef | undefined)}
                    />
                  </div>

                  <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '0.5rem 0' }} />

                  <div className="field">
                    <label>Author Name</label>
                    <input
                      type="text"
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      placeholder="e.g. Hilom Team, Dr. Maria Santos"
                    />
                  </div>

                  <div className="field">
                    <label>Author Photo URL</label>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                      {authorImageUrl ? (
                        <img
                          src={authorImageUrl}
                          alt="Author avatar"
                          style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flex: 'none' }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: '50%',
                            background: 'var(--cream)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--forest)',
                            fontWeight: 'bold',
                            flex: 'none',
                          }}
                        >
                          {authorName ? authorName[0].toUpperCase() : 'A'}
                        </div>
                      )}
                      <input
                        type="text"
                        style={{ flex: 1 }}
                        value={authorImageUrl}
                        onChange={(e) => setAuthorImageUrl(e.target.value)}
                        placeholder="https://..."
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: TAGS */}
              {activeTab === 'tags' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="field">
                    <label>Post Tags</label>
                    <p className="small muted" style={{ marginTop: 0 }}>
                      Type a tag name and press <strong>Enter</strong> or comma to add.
                    </p>

                    <div className="tag-chips">
                      {tags.map((tag) => (
                        <span key={tag} className="tag-chip">
                          #{tag}
                          <button type="button" onClick={() => handleRemoveTag(tag)} title="Remove tag">
                            ✕
                          </button>
                        </span>
                      ))}
                      <input
                        type="text"
                        className="tag-chip-input"
                        placeholder={tags.length === 0 ? 'Type tag and press Enter…' : 'Add another tag…'}
                        value={tagInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.includes(',')) {
                            const parts = val.split(',');
                            parts.forEach((p) => {
                              const t = p.trim().replace(/^#/, '');
                              if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
                            });
                            setTagInput('');
                          } else {
                            setTagInput(val);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTag();
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4: SEO & SOCIAL */}
              {activeTab === 'seo' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div className="field">
                    <label>SEO Title (Override)</label>
                    <input
                      type="text"
                      value={seoTitle}
                      onChange={(e) => setSeoTitle(e.target.value)}
                      placeholder={title ? `${title} — Hilom Collective` : 'Defaults to Post Title'}
                    />
                  </div>

                  <div className="field">
                    <label>SEO Meta Description (Override)</label>
                    <textarea
                      rows={2}
                      value={seoDescription}
                      onChange={(e) => setSeoDescription(e.target.value)}
                      placeholder={excerpt || 'Defaults to Excerpt summary'}
                    />
                  </div>

                  {/* Google Search Live SERP Preview */}
                  <div>
                    <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>
                      Search Engine Preview (Google Mockup)
                    </label>
                    <div className="serp-preview">
                      <div className="serp-preview__url">
                        <span>{effectiveUrl}</span>
                      </div>
                      <div className="serp-preview__title">{effectiveTitle}</div>
                      <div className="serp-preview__desc">{effectiveDescription}</div>
                    </div>
                  </div>

                  {/* Social Share Card Preview */}
                  <div>
                    <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>
                      Social Share Preview (LinkedIn / Facebook / X)
                    </label>
                    <div className="social-preview">
                      {image?.url ? (
                        <img src={image.url} alt="" className="social-preview__image" />
                      ) : (
                        <div className="social-preview__placeholder">No cover image selected</div>
                      )}
                      <div className="social-preview__body">
                        <div className="social-preview__domain">hilomcollective.com</div>
                        <div className="social-preview__title">{effectiveTitle}</div>
                        <div className="social-preview__desc">{effectiveDescription}</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Drawer Footer */}
            <div className="admin-drawer-footer">
              <button className="btn btn-ghost small" onClick={() => setDrawerOpen(false)}>
                Close
              </button>
              <button
                className="btn btn-primary small"
                onClick={handleSaveSettings}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save Post Settings'}
              </button>
            </div>
          </div>
        </div>
      )}
    </BlockEditor>
  );
}

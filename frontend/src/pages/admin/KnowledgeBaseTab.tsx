/**
 * Knowledge base tab — the help centre's article list and section management.
 *
 * Grouped by section rather than presented as one flat table, which is the one
 * real departure from PostsTab. A blog is a feed and sorts by recency; a help
 * centre is a tree, and the question an editor actually arrives with is "what
 * is in Sessions & Booking, and what order does the reader meet it in". A flat
 * list sorted by date answers neither, and hides the gap this view exists to
 * surface — a section with no published articles in it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  adminCreateKbArticle,
  adminCreateKbCategory,
  adminDeleteKbCategory,
  adminListKbArticles,
  adminListKbCategories,
  adminUpdateKbCategory,
  AUDIENCE_LABELS,
  KIND_LABELS,
  type Audience,
  type ArticleKind,
  type KbArticle,
  type KbCategory,
} from '../../lib/kb';

type StatusFilter = 'all' | 'published' | 'draft';
type AudienceFilter = 'all' | Audience;

export default function KnowledgeBaseTab({ adminKey }: { adminKey: string }) {
  const navigate = useNavigate();

  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newKind, setNewKind] = useState<ArticleKind>('guide');
  const [newAudience, setNewAudience] = useState<Audience>('client');

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>('all');

  const [showSections, setShowSections] = useState(false);
  const [catName, setCatName] = useState('');

  async function reload() {
    try {
      const [a, c] = await Promise.all([
        adminListKbArticles(adminKey),
        adminListKbCategories(adminKey),
      ]);
      setArticles(a);
      setCategories(c);
      // Default the create form to the first section so "Create" is never a
      // click that fails on a field the editor did not know was required.
      setNewCategoryId((current) => current || c[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  async function createArticle() {
    if (!title.trim() || !newCategoryId) return;
    setBusy(true);
    setError(null);
    try {
      const article = await adminCreateKbArticle(adminKey, {
        title: title.trim(),
        category_id: newCategoryId,
        kind: newKind,
        audience: newAudience,
      });
      setTitle('');
      navigate(`/admin/knowledge-base/${article.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createCategory() {
    if (!catName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await adminCreateKbCategory(adminKey, {
        name: catName.trim(),
        // Appended to the end rather than inserted: a new section should not
        // silently jump above sections someone deliberately ordered.
        position: (categories[categories.length - 1]?.position ?? 0) + 10,
      });
      setCatName('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function moveCategory(category: KbCategory, direction: -1 | 1) {
    const ordered = [...categories].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((c) => c.id === category.id);
    const swapWith = ordered[index + direction];
    if (!swapWith) return;

    setError(null);
    try {
      // Positions are swapped rather than renumbered, so reordering one pair
      // never rewrites every other section's position.
      await Promise.all([
        adminUpdateKbCategory(adminKey, category.id, {
          name: category.name,
          slug: category.slug,
          description: category.description,
          icon: category.icon,
          position: swapWith.position,
        }),
        adminUpdateKbCategory(adminKey, swapWith.id, {
          name: swapWith.name,
          slug: swapWith.slug,
          description: swapWith.description,
          icon: swapWith.icon,
          position: category.position,
        }),
      ]);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCategory(category: KbCategory) {
    const count = articles.filter((a) => a.category_id === category.id).length;
    if (count > 0) {
      setError(
        `"${category.name}" still holds ${count} article${count === 1 ? '' : 's'}. Move them to another section first.`,
      );
      return;
    }
    if (!window.confirm(`Delete the section "${category.name}"?`)) return;
    setError(null);
    try {
      await adminDeleteKbCategory(adminKey, category.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return articles.filter((a) => {
      const matchesSearch =
        !q ||
        a.title.toLowerCase().includes(q) ||
        a.slug.toLowerCase().includes(q) ||
        (a.summary ?? '').toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q));
      const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
      const matchesAudience = audienceFilter === 'all' || a.audience === audienceFilter;
      return matchesSearch && matchesStatus && matchesAudience;
    });
  }, [articles, searchQuery, statusFilter, audienceFilter]);

  /** Sections in reading order, each with its matching articles. */
  const grouped = useMemo(() => {
    const byCategory = new Map<string, KbArticle[]>();
    for (const a of filtered) {
      const list = byCategory.get(a.category_id) ?? [];
      list.push(a);
      byCategory.set(a.category_id, list);
    }
    return [...categories]
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        category,
        articles: (byCategory.get(category.id) ?? []).sort(
          (a, b) => a.position - b.position || a.title.localeCompare(b.title),
        ),
      }));
  }, [categories, filtered]);

  const publishedCount = articles.filter((a) => a.status === 'published').length;
  const draftCount = articles.filter((a) => a.status === 'draft').length;
  const filtersActive = Boolean(searchQuery) || statusFilter !== 'all' || audienceFilter !== 'all';

  return (
    <>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Total Articles</span>
          <span className="admin-stat-card__value">{articles.length}</span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Published</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--forest)' }}>
            {publishedCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Drafts</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--ochre-dark)' }}>
            {draftCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Sections</span>
          <span className="admin-stat-card__value">{categories.length}</span>
        </div>
      </div>

      {/* Create */}
      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>New Article</h2>
        {categories.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            Create a section first — every article has to live in one.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input
                style={{ flex: '2 1 260px' }}
                placeholder="Article title (e.g. 'Rescheduling your session')"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && title.trim()) void createArticle();
                }}
              />
              <select
                style={{ flex: '1 1 160px' }}
                value={newCategoryId}
                onChange={(e) => setNewCategoryId(e.target.value)}
              >
                {[...categories]
                  .sort((a, b) => a.position - b.position)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <select
                style={{ flex: '0 1 150px' }}
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as ArticleKind)}
              >
                <option value="guide">Guide</option>
                <option value="troubleshooting">Troubleshooting</option>
              </select>
              <select
                style={{ flex: '0 1 140px' }}
                value={newAudience}
                onChange={(e) => setNewAudience(e.target.value as Audience)}
              >
                <option value="client">Clients</option>
                <option value="facilitator">Facilitators</option>
                <option value="both">Everyone</option>
              </select>
              <button
                className="btn btn-primary"
                onClick={createArticle}
                disabled={busy || !title.trim() || !newCategoryId}
              >
                Create &amp; Edit
              </button>
            </div>
            <p className="small muted" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
              The URL is generated from the title and can be changed later. New articles start as
              drafts and are invisible to readers until published.
            </p>
          </>
        )}
      </div>

      {/* Sections */}
      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Sections ({categories.length})</h2>
          <button className="btn btn-ghost small" onClick={() => setShowSections((v) => !v)}>
            {showSections ? 'Hide' : 'Manage sections'}
          </button>
        </div>

        {showSections && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                style={{ flex: 1 }}
                placeholder="New section name (e.g. 'Payments & Refunds')"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && catName.trim()) void createCategory();
                }}
              />
              <button
                className="btn btn-accent"
                onClick={createCategory}
                disabled={busy || !catName.trim()}
              >
                Add Section
              </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>URL</th>
                    <th>Articles</th>
                    <th style={{ textAlign: 'right' }}>Order</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...categories]
                    .sort((a, b) => a.position - b.position)
                    .map((c, index, sorted) => {
                      const count = articles.filter((a) => a.category_id === c.id).length;
                      return (
                        <tr key={c.id}>
                          <td>
                            <strong style={{ fontSize: '0.95rem' }}>{c.name}</strong>
                            {c.description && (
                              <div className="small muted">{c.description}</div>
                            )}
                          </td>
                          <td className="small mono muted">/help/{c.slug}</td>
                          <td className="small">{count}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              className="btn btn-ghost small"
                              onClick={() => moveCategory(c, -1)}
                              disabled={index === 0}
                              title="Move up"
                            >
                              ↑
                            </button>
                            <button
                              className="btn btn-ghost small"
                              onClick={() => moveCategory(c, 1)}
                              disabled={index === sorted.length - 1}
                              title="Move down"
                            >
                              ↓
                            </button>
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              className="btn btn-ghost small"
                              onClick={() => deleteCategory(c)}
                              // A section holding articles cannot be deleted —
                              // the FK refuses it and the button says so before
                              // the click rather than after.
                              disabled={count > 0}
                              title={
                                count > 0
                                  ? 'Move its articles elsewhere first'
                                  : 'Delete this section'
                              }
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Articles, grouped by section */}
      <div className="panel">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginBottom: '1rem',
          }}
        >
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Articles ({filtered.length})</h2>
        </div>

        <div className="admin-toolbar">
          <input
            type="text"
            className="search-input"
            placeholder="Search articles by title, URL, summary, or tag…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">All Statuses</option>
            <option value="published">Published ({publishedCount})</option>
            <option value="draft">Drafts ({draftCount})</option>
          </select>
          <select
            value={audienceFilter}
            onChange={(e) => setAudienceFilter(e.target.value as AudienceFilter)}
          >
            <option value="all">Everyone</option>
            <option value="client">Clients</option>
            <option value="facilitator">Facilitators</option>
            <option value="both">Marked for everyone</option>
          </select>
          {filtersActive && (
            <button
              className="btn btn-ghost small"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
                setAudienceFilter('all');
              }}
            >
              Reset Filters
            </button>
          )}
        </div>

        {articles.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <p className="muted" style={{ marginBottom: 0 }}>
              No help articles yet.
            </p>
          </div>
        ) : (
          grouped.map(({ category, articles: rows }) => (
            <div key={category.id} style={{ marginBottom: '1.75rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <h3 style={{ fontSize: '0.95rem', margin: 0 }}>{category.name}</h3>
                <span className="small muted">
                  {rows.length} article{rows.length === 1 ? '' : 's'}
                </span>
              </div>

              {rows.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  {filtersActive ? 'Nothing here matches your filters.' : 'Nothing in this section yet.'}
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Title &amp; URL</th>
                        <th>Type</th>
                        <th>Audience</th>
                        <th>Status</th>
                        <th title="How many readers marked this article helpful">Helpful</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <strong style={{ fontSize: '0.95rem', display: 'block' }}>
                              {a.title}
                            </strong>
                            <span className="small mono muted">
                              /help/{category.slug}/{a.slug}
                            </span>
                          </td>
                          <td className="small">{KIND_LABELS[a.kind]}</td>
                          <td className="small">{AUDIENCE_LABELS[a.audience]}</td>
                          <td>
                            <span
                              className={a.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}
                            >
                              {a.status}
                            </span>
                          </td>
                          <td className="small">
                            {a.helpful_yes > 0 ? a.helpful_yes : <span className="muted">—</span>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {a.status === 'published' && (
                              <a
                                href={`/help/${category.slug}/${a.slug}`}
                                target="_blank"
                                rel="noreferrer"
                                className="btn btn-ghost small"
                                style={{ marginRight: '0.35rem', textDecoration: 'none' }}
                                title="View live article"
                              >
                                View ↗
                              </a>
                            )}
                            <button
                              className="btn btn-accent small"
                              onClick={() => navigate(`/admin/knowledge-base/${a.id}`)}
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

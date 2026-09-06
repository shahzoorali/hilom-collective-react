/**
 * Knowledge base article editor — markdown body, metadata, publish, revisions.
 *
 * A plain textarea rather than the Puck block editor the pages and posts use.
 * The body column is markdown (see the note at the top of
 * 0037_knowledge_base.sql), and a block composer over a linear document would
 * make writing fifty troubleshooting articles slower without making any of them
 * better.
 *
 * **A save to a published article is live immediately.** There is no draft copy
 * to stage into, which is deliberate: the common edit here is correcting an
 * instruction people are following right now. The banner says so, because an
 * editor who believes they are typing into a draft is the one way this design
 * goes wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adminDeleteKbArticle,
  adminGetKbArticle,
  adminListKbCategories,
  adminListKbRevisions,
  adminPublishKbArticle,
  adminRestoreKbRevision,
  adminUnpublishKbArticle,
  adminUpdateKbArticle,
  type ArticleKind,
  type Audience,
  type KbArticle,
  type KbCategory,
  type KbRevision,
} from '../../lib/kb';

interface Props {
  adminKey: string;
  articleId: string;
  onBack: () => void;
}

/** The editable shape, kept separate from the server row so dirty-checking is a plain compare. */
interface Draft {
  title: string;
  slug: string;
  category_id: string;
  summary: string;
  body: string;
  kind: ArticleKind;
  audience: Audience;
  position: number;
  tags: string;
  seo_title: string;
  seo_description: string;
}

const toDraft = (a: KbArticle): Draft => ({
  title: a.title,
  slug: a.slug,
  category_id: a.category_id,
  summary: a.summary ?? '',
  body: a.body ?? '',
  kind: a.kind,
  audience: a.audience,
  position: a.position,
  tags: a.tags.join(', '),
  seo_title: a.seo_title ?? '',
  seo_description: a.seo_description ?? '',
});

export default function KbArticleEditor({ adminKey, articleId, onBack }: Props) {
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [revisions, setRevisions] = useState<KbRevision[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The last saved state, for dirty-checking. */
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showRevisions, setShowRevisions] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        adminGetKbArticle(adminKey, articleId),
        adminListKbCategories(adminKey),
      ]);
      setArticle(a);
      setCategories(c);
      const d = toDraft(a);
      setDraft(d);
      setSaved(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [adminKey, articleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () => Boolean(draft && saved) && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  // Losing a half-written article to a stray back-navigation is the kind of
  // thing that stops someone writing the next one.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save(): Promise<boolean> {
    if (!draft) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminUpdateKbArticle(adminKey, articleId, {
        title: draft.title,
        slug: draft.slug,
        category_id: draft.category_id,
        summary: draft.summary.trim() || null,
        body: draft.body,
        kind: draft.kind,
        audience: draft.audience,
        position: draft.position,
        tags: draft.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        seo_title: draft.seo_title.trim() || null,
        seo_description: draft.seo_description.trim() || null,
      });
      setArticle(updated);
      setSaved(draft);
      setNotice(
        updated.status === 'published' ? 'Saved — the change is live now.' : 'Saved as a draft.',
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    // Saving first, because publishing what is on the server rather than what
    // is on screen would quietly go live with the previous text.
    if (dirty && !(await save())) return;
    setBusy(true);
    setError(null);
    try {
      setArticle(await adminPublishKbArticle(adminKey, articleId));
      setNotice('Published — readers can find this now.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!window.confirm('Hide this article from readers? It stays here as a draft.')) return;
    setBusy(true);
    setError(null);
    try {
      setArticle(await adminUnpublishKbArticle(adminKey, articleId));
      setNotice('Unpublished — this is no longer visible to readers.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Permanently delete "${article?.title}"? There is no trash for help articles — ` +
          'unpublish instead if you only want it hidden.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await adminDeleteKbArticle(adminKey, articleId);
      onBack();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function openRevisions() {
    setShowRevisions((v) => !v);
    if (showRevisions) return;
    try {
      setRevisions(await adminListKbRevisions(adminKey, articleId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function restore(revision: KbRevision) {
    if (
      !window.confirm(
        'Replace the current text with this earlier version? The current text is kept as a ' +
          'revision, so this can be undone.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await adminRestoreKbRevision(adminKey, articleId, revision.id);
      setArticle(updated);
      const d = toDraft(updated);
      setDraft(d);
      setSaved(d);
      setRevisions(await adminListKbRevisions(adminKey, articleId));
      setNotice('Restored.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (!article || !draft) {
    return (
      <>
        {error && <div className="alert alert-error">{error}</div>}
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back to Knowledge Base
        </button>
      </>
    );
  }

  const category = categories.find((c) => c.id === draft.category_id);
  const isPublished = article.status === 'published';
  const bodyEmpty = !draft.body.trim();
  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0;

  return (
    <>
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
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (dirty && !window.confirm('You have unsaved changes. Leave anyway?')) return;
            onBack();
          }}
        >
          ← Back to Knowledge Base
        </button>

        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={isPublished ? 'pill pill-ok' : 'pill pill-warn'}>{article.status}</span>
          {dirty && <span className="small muted">Unsaved changes</span>}
          {isPublished && category && (
            <a
              href={`/help/${category.slug}/${article.slug}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost small"
              style={{ textDecoration: 'none' }}
            >
              View ↗
            </a>
          )}
          <button className="btn btn-ghost small" onClick={openRevisions}>
            History
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {isPublished ? (
            <button className="btn btn-ghost" onClick={unpublish} disabled={busy}>
              Unpublish
            </button>
          ) : (
            <button
              className="btn btn-accent"
              onClick={publish}
              disabled={busy || bodyEmpty}
              title={bodyEmpty ? 'Write something first — an empty article cannot be published' : undefined}
            >
              Publish
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="alert" style={{ marginBottom: '1rem' }}>
          {notice}
        </div>
      )}

      {isPublished && (
        <div className="alert" style={{ marginBottom: '1rem' }}>
          This article is live. Saving publishes your changes immediately — there is no separate
          draft copy. Unpublish first if you need to rework it out of sight.
        </div>
      )}

      {showRevisions && (
        <div className="panel" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>History</h2>
          {revisions.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              No earlier versions yet. One is kept each time the text changes.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>What</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="small muted">{r.note ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-ghost small"
                        onClick={() => restore(r)}
                        disabled={busy}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="admin-editor-grid">
        {/* Body */}
        <div className="panel">
          <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
            Title
          </label>
          <input
            style={{ width: '100%', fontSize: '1.05rem', marginBottom: '1rem' }}
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
          />

          <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
            Summary
          </label>
          <input
            style={{ width: '100%', marginBottom: '0.35rem' }}
            placeholder="One line, shown under the title in listings and in search results"
            value={draft.summary}
            onChange={(e) => set('summary', e.target.value)}
            maxLength={300}
          />
          <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
            {draft.summary.length}/300 — this is also the description search engines show, and most
            readers arrive from a search engine.
          </p>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '0.35rem',
            }}
          >
            <label className="small">Body (Markdown)</label>
            <span className="small muted">
              {words} word{words === 1 ? '' : 's'}
            </span>
          </div>
          <textarea
            ref={bodyRef}
            className="mono"
            style={{ width: '100%', minHeight: '30rem', lineHeight: 1.6, fontSize: '0.9rem' }}
            value={draft.body}
            onChange={(e) => set('body', e.target.value)}
            placeholder={
              '## What to do\n\n1. Open your bookings page\n2. Find the session\n\n' +
              "> Note: rescheduling closes 24 hours before the session starts."
            }
          />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Markdown: <code>##</code> for headings, <code>-</code> for bullets, <code>1.</code> for
            steps, <code>&gt;</code> for a callout, <code>[text](url)</code> for links.
          </p>
        </div>

        {/* Metadata */}
        <div>
          <div className="panel" style={{ marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Placement</h2>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              Section
            </label>
            <select
              style={{ width: '100%', marginBottom: '1rem' }}
              value={draft.category_id}
              onChange={(e) => set('category_id', e.target.value)}
            >
              {[...categories]
                .sort((a, b) => a.position - b.position)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              Type
            </label>
            <select
              style={{ width: '100%', marginBottom: '0.35rem' }}
              value={draft.kind}
              onChange={(e) => set('kind', e.target.value as ArticleKind)}
            >
              <option value="guide">Guide</option>
              <option value="troubleshooting">Troubleshooting</option>
            </select>
            <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
              Troubleshooting articles are grouped separately at the foot of their section.
            </p>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              Audience
            </label>
            <select
              style={{ width: '100%', marginBottom: '0.35rem' }}
              value={draft.audience}
              onChange={(e) => set('audience', e.target.value as Audience)}
            >
              <option value="client">Clients</option>
              <option value="facilitator">Facilitators</option>
              <option value="both">Everyone</option>
            </select>
            <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
              Filters and ranks search. Every article is publicly readable either way — this is not
              a permission.
            </p>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              Order within the section
            </label>
            <input
              type="number"
              style={{ width: '100%', marginBottom: '0.35rem' }}
              value={draft.position}
              onChange={(e) => set('position', Number(e.target.value))}
              min={0}
            />
            <p className="small muted" style={{ marginTop: 0, marginBottom: 0 }}>
              Lower numbers come first. Leave gaps (10, 20, 30) so an article can be slotted between
              two later.
            </p>
          </div>

          <div className="panel" style={{ marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>URL &amp; tags</h2>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              URL slug
            </label>
            <input
              className="mono"
              style={{ width: '100%', marginBottom: '0.35rem' }}
              value={draft.slug}
              onChange={(e) => set('slug', e.target.value)}
            />
            <p className="small muted" style={{ marginTop: 0, marginBottom: '1rem' }}>
              {category ? `/help/${category.slug}/${draft.slug}` : `/help/…/${draft.slug}`}
              {isPublished && ' — changing this breaks existing links to the article.'}
            </p>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              Tags
            </label>
            <input
              style={{ width: '100%', marginBottom: '0.35rem' }}
              placeholder="booking, refunds, meetings"
              value={draft.tags}
              onChange={(e) => set('tags', e.target.value)}
            />
            <p className="small muted" style={{ marginTop: 0, marginBottom: 0 }}>
              Comma-separated. Tags are how "Related articles" finds matches outside this section.
            </p>
          </div>

          <div className="panel" style={{ marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Search engines</h2>

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              SEO title
            </label>
            <input
              style={{ width: '100%', marginBottom: '1rem' }}
              placeholder={draft.title}
              value={draft.seo_title}
              onChange={(e) => set('seo_title', e.target.value)}
              maxLength={120}
            />

            <label className="small" style={{ display: 'block', marginBottom: '0.35rem' }}>
              SEO description
            </label>
            <textarea
              style={{ width: '100%', minHeight: '5rem' }}
              placeholder={draft.summary || 'Falls back to the summary above'}
              value={draft.seo_description}
              onChange={(e) => set('seo_description', e.target.value)}
              maxLength={300}
            />
            <p className="small muted" style={{ marginTop: 0, marginBottom: 0 }}>
              Both fall back to the title and summary when left empty.
            </p>
          </div>

          <div className="panel">
            <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Article</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              {article.published_at
                ? `First published ${new Date(article.published_at).toLocaleDateString()}. `
                : 'Never published. '}
              Last edited {new Date(article.updated_at).toLocaleString()}.
              {article.helpful_yes > 0 &&
                ` ${article.helpful_yes} reader${article.helpful_yes === 1 ? '' : 's'} found it helpful.`}
            </p>
            <button
              className="btn btn-ghost small"
              onClick={remove}
              disabled={busy}
              style={{ color: 'var(--danger, #b23)' }}
            >
              Delete permanently
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The page editor, built on Puck.
 *
 * Puck owns the canvas: drag blocks in from the left, click one on the page to
 * select it, edit it in the right-hand panel, drag to reorder. What it does NOT
 * own is any of our data: it is handed a block array and hands one back, so the
 * `pages` table, the publish/revision endpoints, and the server-side sanitizer
 * are unchanged from the hand-rolled editor this replaced.
 *
 * Two integration choices worth knowing:
 *
 *  - `iframe={{ enabled: false }}`. Puck renders its preview in an iframe by
 *    default, which would isolate the canvas from the site's global stylesheet
 *    and make every block render unstyled. Rendering inline means the preview
 *    picks up index.css, so what the editor sees is genuinely what ships.
 *  - Save / Publish / Unpublish live in Puck's own header via the
 *    `headerActions` override, rather than in a separate toolbar above it, so
 *    the editor keeps Puck's undo/redo and viewport controls next to them.
 */
import { useEffect, useRef, useState } from 'react';
import { Puck, type Data } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import type { Block } from '../../cms/blocks';
import {
  adminGetPage,
  adminListRevisions,
  adminPublishPage,
  adminRestoreRevision,
  adminSaveDraft,
  adminUnpublishPage,
  type AdminPage,
  type PageRevision,
} from '../../lib/cms';
import { createPuckConfig } from './puckConfig';

/**
 * Puck keeps each block's id inside `props`; we store it alongside `type`.
 * These two functions are the whole of the format difference.
 */
function toPuckData(blocks: Block[]): Data {
  return {
    root: {},
    content: blocks.map((block) => ({ type: block.type, props: { ...block.props, id: block.id } })),
  } as Data;
}

function fromPuckData(data: Data): Block[] {
  return (data.content ?? []).map((item, i) => {
    const { id, ...props } = item.props as Record<string, unknown> & { id?: string };
    return { id: typeof id === 'string' ? id : `b-${i}-${Date.now()}`, type: item.type as string, props };
  });
}

export default function PageEditor({
  adminKey,
  pageId,
  onBack,
}: {
  adminKey: string;
  pageId: string;
  onBack: () => void;
}) {
  const [page, setPage] = useState<AdminPage | null>(null);
  const [initialData, setInitialData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<PageRevision[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Puck is uncontrolled once mounted: it owns edit state and reports changes.
  // Keeping the latest in a ref (rather than state) avoids re-rendering the
  // whole editor on every keystroke.
  const latest = useRef<Block[]>([]);
  const [config] = useState(() => createPuckConfig(adminKey));

  useEffect(() => {
    adminGetPage(adminKey, pageId)
      .then((p) => {
        setPage(p);
        const blocks = p.draft_blocks ?? [];
        latest.current = blocks;
        setInitialData(toPuckData(blocks));
      })
      .catch((e: Error) => setError(e.message));
    adminListRevisions(adminKey, pageId).then(setRevisions).catch(() => setRevisions([]));
  }, [adminKey, pageId]);

  // Closing the tab mid-edit would silently lose the draft.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      setPage(await adminSaveDraft(adminKey, pageId, latest.current));
      setDirty(false);
    }, 'Draft saved.');

  const publish = () =>
    run(async () => {
      // Publish what is on the canvas, not what was last saved — that is what an
      // editor pressing Publish means.
      await adminSaveDraft(adminKey, pageId, latest.current);
      setPage(await adminPublishPage(adminKey, pageId));
      setDirty(false);
      setRevisions(await adminListRevisions(adminKey, pageId));
    }, 'Published — the page is live.');

  const unpublish = () =>
    run(async () => {
      setPage(await adminUnpublishPage(adminKey, pageId));
    }, 'Unpublished. The built-in page is being served again.');

  /** Restoring replaces the canvas, so Puck is remounted with the new content
   *  by keying it on the loaded data. */
  const restore = (revisionId: string) =>
    run(async () => {
      const restored = await adminRestoreRevision(adminKey, pageId, revisionId);
      const blocks = restored.draft_blocks ?? [];
      latest.current = blocks;
      setInitialData(toPuckData(blocks));
      setDirty(false);
      setShowHistory(false);
    }, 'Revision loaded onto the canvas. Publish it to make it live.');

  if (error && !page) return <div className="alert alert-error" style={{ margin: '1rem' }}>{error}</div>;
  if (!page || !initialData) return <p className="muted" style={{ margin: '1rem' }}>Loading…</p>;

  return (
    // Flex column filling the exact space .admin-content--flush gives it (see
    // index.css): alerts and history take only the room they need, and the
    // Puck canvas takes the rest, edge to edge. That full-viewport layout is
    // the point — a page editor boxed inside a padded container is what this
    // replaced.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {(error || notice || showHistory) && (
        <div style={{ padding: '0.75rem 1rem 0' }}>
          {error && <div className="alert alert-error">{error}</div>}
          {notice && <div className="alert alert-success">{notice}</div>}

          {showHistory && (
            <div className="panel" style={{ marginBottom: '0.8rem' }}>
              <h3 style={{ fontSize: '1rem', marginTop: 0 }}>Publish history</h3>
              {revisions.length === 0 ? (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Nothing published yet.
                </p>
              ) : (
                revisions.map((revision) => (
                  <button
                    key={revision.id}
                    className="btn btn-ghost small"
                    style={{ marginRight: '0.4rem', marginBottom: '0.4rem' }}
                    onClick={() => restore(revision.id)}
                    disabled={busy}
                  >
                    {new Date(revision.created_at).toLocaleString()}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* flex: 1 + minHeight: 0 is the standard fix for a flex child that must
          fill remaining space but also contains its own scrolling content —
          without minHeight: 0 the browser lets this box grow past its share. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Puck
          key={page.id + String(initialData.content?.length) + (page.published_at ?? '')}
          config={config}
          data={initialData}
          iframe={{ enabled: false }}
          headerTitle={`${page.title} — /${page.slug === 'home' ? '' : page.slug}`}
          onChange={(data) => {
            latest.current = fromPuckData(data);
            setDirty(true);
          }}
          onPublish={() => void publish()}
          overrides={{
            headerActions: ({ children }) => (
              <>
                <button className="btn btn-ghost small" onClick={onBack} disabled={busy}>
                  ← All pages
                </button>
                <span className={page.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                  {page.status}
                </span>
                <button
                  className="btn btn-ghost small"
                  onClick={() => setShowHistory((s) => !s)}
                  disabled={busy}
                >
                  History
                </button>
                <button className="btn btn-ghost small" onClick={save} disabled={busy || !dirty}>
                  {dirty ? 'Save draft' : 'Saved'}
                </button>
                {page.status === 'published' && (
                  <button className="btn btn-ghost small" onClick={unpublish} disabled={busy}>
                    Unpublish
                  </button>
                )}
                {/* Puck's own Publish button, which routes to onPublish above. */}
                {children}
              </>
            ),
          }}
        />
      </div>
    </div>
  );
}

/**
 * The block editor, built on Puck — parameterized by a resource adapter.
 *
 * Provides a full-height, distraction-free canvas with modern toast notifications,
 * a clean revision history modal, status badges, and extensible header actions
 * (such as Post Settings drawer trigger).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Puck, type Data } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import type { Block } from '../../cms/blocks';
import { createPuckConfig } from './puckConfig';

/**
 * Resource adapter — the contract between the editor and whichever CMS
 * resource type it is editing.
 */
export interface EditorAdapter<
  T extends { id: string; slug: string; title: string; status: 'draft' | 'published'; draft_blocks?: Block[] },
> {
  /** Human label for the resource type, e.g. "page" or "post". */
  label: string;
  /** Load the resource including its draft blocks. */
  load: (key: string) => Promise<T>;
  /** Save blocks to the draft column. */
  saveDraft: (key: string, blocks: Block[]) => Promise<T>;
  /** Publish: copy draft to published. */
  publish: (key: string) => Promise<T>;
  /** Unpublish: set status to draft. */
  unpublish: (key: string) => Promise<T>;
  /** List revision history. */
  listRevisions: (key: string) => Promise<{ id: string; note: string | null; created_at: string }[]>;
  /** Restore a revision's blocks back into draft. */
  restoreRevision: (key: string, revisionId: string) => Promise<T>;
  /** Build the header title string. */
  headerTitle: (resource: T) => string;
  /** Publish notice — the message shown after publishing. */
  publishNotice?: string;
  /** Optional public URL helper for "View live" */
  viewUrl?: (resource: T) => string;
}

/**
 * Puck keeps each block's id inside `props`; we store it alongside `type`.
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

export default function BlockEditor<
  T extends { id: string; slug: string; title: string; status: 'draft' | 'published'; draft_blocks?: Block[] },
>({
  adminKey,
  resourceId,
  adapter,
  onBack,
  backLabel,
  renderExtraHeaderActions,
  children,
}: {
  adminKey: string;
  resourceId: string;
  adapter: EditorAdapter<T>;
  onBack: () => void;
  backLabel?: string;
  renderExtraHeaderActions?: (resource: T) => ReactNode;
  children?: ReactNode;
}) {
  const [resource, setResource] = useState<T | null>(null);
  const [initialData, setInitialData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [revisions, setRevisions] = useState<{ id: string; note: string | null; created_at: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [canvasVersion, setCanvasVersion] = useState(0);

  const latest = useRef<Block[]>([]);
  const [config] = useState(() => createPuckConfig(adminKey));

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    adapter
      .load(resourceId)
      .then((r) => {
        setResource(r);
        const blocks = r.draft_blocks ?? [];
        latest.current = blocks;
        setInitialData(toPuckData(blocks));
        setCanvasVersion((v) => v + 1);
      })
      .catch((e: Error) => setError(e.message));
    adapter.listRevisions(resourceId).then(setRevisions).catch(() => setRevisions([]));
  }, [adminKey, resourceId, adapter]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setToast({ type: 'success', message });
    } catch (e) {
      const err = (e as Error).message;
      setError(err);
      setToast({ type: 'error', message: err });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      setResource(await adapter.saveDraft(resourceId, latest.current));
      setDirty(false);
    }, 'Draft saved successfully.');

  const publish = () =>
    run(async () => {
      await adapter.saveDraft(resourceId, latest.current);
      const updated = await adapter.publish(resourceId);
      setResource(updated);
      setDirty(false);
      setRevisions(await adapter.listRevisions(resourceId));
    }, adapter.publishNotice ?? 'Published — content is now live.');

  const unpublish = () =>
    run(async () => {
      const updated = await adapter.unpublish(resourceId);
      setResource(updated);
    }, 'Unpublished. Post is now in draft status.');

  const restore = (revisionId: string) =>
    run(async () => {
      const restored = await adapter.restoreRevision(resourceId, revisionId);
      const blocks = restored.draft_blocks ?? [];
      latest.current = blocks;
      setInitialData(toPuckData(blocks));
      setCanvasVersion((v) => v + 1);
      setDirty(false);
      setShowHistory(false);
    }, 'Revision loaded onto canvas. Click Publish to make it live.');

  if (error && !resource) {
    return (
      <div style={{ padding: '2rem', maxWidth: 600, margin: '2rem auto' }} className="panel">
        <div className="alert alert-error">{error}</div>
        <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: '1rem' }}>
          ← {backLabel ?? `Back to ${adapter.label}s`}
        </button>
      </div>
    );
  }

  if (!resource || !initialData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p className="muted">Loading editor…</p>
      </div>
    );
  }

  const liveUrl = adapter.viewUrl ? adapter.viewUrl(resource) : undefined;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toast Notification Container */}
      {toast && (
        <div className="admin-toast-container">
          <div className={`admin-toast admin-toast--${toast.type}`}>
            <span>{toast.type === 'success' ? '✓' : '⚠'}</span>
            <span>{toast.message}</span>
            <button
              onClick={() => setToast(null)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 0 0 0.5rem', opacity: 0.8 }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Revision History Modal */}
      {showHistory && (
        <div className="admin-modal-overlay" onClick={() => setShowHistory(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Publish History ({revisions.length})</h3>
              <button
                className="btn btn-ghost small"
                onClick={() => setShowHistory(false)}
                style={{ padding: '0.2rem 0.5rem' }}
              >
                ✕
              </button>
            </div>
            <div className="admin-modal-body">
              {revisions.length === 0 ? (
                <p className="muted" style={{ margin: '1rem 0' }}>
                  No published revisions recorded yet. Revisions are created automatically every time you publish.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {revisions.map((rev, idx) => (
                    <div
                      key={rev.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.75rem 1rem',
                        background: 'var(--page)',
                        borderRadius: 'var(--radius)',
                        border: '1px solid var(--line)',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                          {new Date(rev.created_at).toLocaleString()}
                        </div>
                        <div className="small muted">
                          {idx === 0 ? 'Current live version' : rev.note || 'Published revision'}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost small"
                        onClick={() => restore(rev.id)}
                        disabled={busy}
                      >
                        Restore to Canvas
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Full-viewport Puck canvas. The layout/scrolling overrides this needs live in
          index.css under "Puck Editor Canvas & Layout Scrolling Fixes" — they used to be
          duplicated here as an inline <style>, and the two copies drifted apart, which
          made the canvas-height bug much harder to see. One copy only. */}
      <div style={{ flex: 1, minHeight: 0, height: '100%' }}>
        <Puck
          key={`${resource.id}:${canvasVersion}`}
          config={config}
          data={initialData}
          iframe={{ enabled: false }}
          headerTitle={adapter.headerTitle(resource)}
          onChange={(data) => {
            latest.current = fromPuckData(data);
            setDirty(true);
          }}
          onPublish={() => void publish()}
          overrides={{
            headerActions: ({ children: puckPublishButton }) => (
              <>
                <button className="btn btn-ghost small" onClick={onBack} disabled={busy} title="Return to list">
                  ← {backLabel ?? `All ${adapter.label}s`}
                </button>

                <span
                  className={resource.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}
                  style={{ textTransform: 'capitalize', fontSize: '0.78rem' }}
                >
                  {resource.status}
                </span>

                {/* Extra custom actions (like Post Settings) */}
                {renderExtraHeaderActions && renderExtraHeaderActions(resource)}

                <button
                  className="btn btn-ghost small"
                  onClick={() => setShowHistory(true)}
                  disabled={busy}
                  title="View revision history"
                >
                  History ({revisions.length})
                </button>

                {liveUrl && resource.status === 'published' && (
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost small"
                    style={{ textDecoration: 'none' }}
                    title="Open live page in new tab"
                  >
                    View live ↗
                  </a>
                )}

                <button
                  className={dirty ? 'btn btn-primary small' : 'btn btn-ghost small'}
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  {dirty ? '● Save draft' : 'Saved'}
                </button>

                {resource.status === 'published' && (
                  <button
                    className="btn btn-ghost small"
                    onClick={unpublish}
                    disabled={busy}
                    style={{ color: 'var(--danger-fg)' }}
                  >
                    Unpublish
                  </button>
                )}

                {puckPublishButton}
              </>
            ),
          }}
        />
      </div>

      {/* Children (e.g. Slide-over Post Settings Drawer) */}
      {children}
    </div>
  );
}

/**
 * The block editor, built on Puck — parameterized by a resource adapter.
 *
 * Originally PageEditor.tsx, which was bound to page endpoints. The adapter
 * pattern lets the same ~250 lines of Puck wiring drive both pages and posts
 * (and anything else with a draft/publish/revision lifecycle in the future).
 *
 * The adapter supplies: load, saveDraft, publish, unpublish, listRevisions,
 * restoreRevision, plus display labels. The editor itself never mentions
 * "page" or "post" — it works with whatever the adapter says.
 */
import { useEffect, useRef, useState } from 'react';
import { Puck, type Data } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import type { Block } from '../../cms/blocks';
import { createPuckConfig } from './puckConfig';

/**
 * Resource adapter — the contract between the editor and whichever CMS
 * resource type it is editing.
 */
export interface EditorAdapter<T extends { id: string; slug: string; title: string; status: 'draft' | 'published'; draft_blocks?: Block[] }> {
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
}

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

export default function BlockEditor<
  T extends { id: string; slug: string; title: string; status: 'draft' | 'published'; draft_blocks?: Block[] },
>({
  adminKey,
  resourceId,
  adapter,
  onBack,
  backLabel,
}: {
  adminKey: string;
  resourceId: string;
  adapter: EditorAdapter<T>;
  onBack: () => void;
  backLabel?: string;
}) {
  const [resource, setResource] = useState<T | null>(null);
  const [initialData, setInitialData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<{ id: string; note: string | null; created_at: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [canvasVersion, setCanvasVersion] = useState(0);

  const latest = useRef<Block[]>([]);
  const [config] = useState(() => createPuckConfig(adminKey));

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
      setResource(await adapter.saveDraft(resourceId, latest.current));
      setDirty(false);
    }, 'Draft saved.');

  const publish = () =>
    run(async () => {
      await adapter.saveDraft(resourceId, latest.current);
      setResource(await adapter.publish(resourceId));
      setDirty(false);
      setRevisions(await adapter.listRevisions(resourceId));
    }, adapter.publishNotice ?? 'Published — live now.');

  const unpublish = () =>
    run(async () => {
      setResource(await adapter.unpublish(resourceId));
    }, 'Unpublished.');

  const restore = (revisionId: string) =>
    run(async () => {
      const restored = await adapter.restoreRevision(resourceId, revisionId);
      const blocks = restored.draft_blocks ?? [];
      latest.current = blocks;
      setInitialData(toPuckData(blocks));
      setCanvasVersion((v) => v + 1);
      setDirty(false);
      setShowHistory(false);
    }, 'Revision loaded onto the canvas. Publish it to make it live.');

  if (error && !resource) return <div className="alert alert-error" style={{ margin: '1rem' }}>{error}</div>;
  if (!resource || !initialData) return <p className="muted" style={{ margin: '1rem' }}>Loading…</p>;

  return (
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

      <div style={{ flex: 1, minHeight: 0 }}>
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
            headerActions: ({ children }) => (
              <>
                <button className="btn btn-ghost small" onClick={onBack} disabled={busy}>
                  ← {backLabel ?? `All ${adapter.label}s`}
                </button>
                <span className={resource.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                  {resource.status}
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
                {resource.status === 'published' && (
                  <button className="btn btn-ghost small" onClick={unpublish} disabled={busy}>
                    Unpublish
                  </button>
                )}
                {children}
              </>
            ),
          }}
        />
      </div>
    </div>
  );
}

/**
 * The block editor: block list on the left, property panel on the right, live
 * preview below.
 *
 * The preview renders the in-memory draft through the production BlockRenderer,
 * so it needs no server round-trip, no preview token, and cannot drift from
 * what visitors will see.
 */
import { useEffect, useState } from 'react';
import { BLOCK_CATALOG, emptyBlock, type Block } from '../../cms/blocks';
import BlockRenderer from '../../cms/BlockRenderer';
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
import BlockPropsForm from './BlockPropsForm';

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
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<PageRevision[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    adminGetPage(adminKey, pageId)
      .then((p) => {
        setPage(p);
        setBlocks(p.draft_blocks ?? []);
      })
      .catch((e: Error) => setError(e.message));
    adminListRevisions(adminKey, pageId).then(setRevisions).catch(() => setRevisions([]));
  }, [adminKey, pageId]);

  // Closing the tab mid-edit would silently lose the draft; the browser's own
  // prompt is the only thing that can interrupt that.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function update(next: Block[]) {
    setBlocks(next);
    setDirty(true);
  }

  function move(i: number, delta: number) {
    const target = i + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[target]] = [next[target], next[i]];
    update(next);
    setSelected(target);
  }

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
      const saved = await adminSaveDraft(adminKey, pageId, blocks);
      setPage(saved);
      setDirty(false);
    }, 'Draft saved.');

  const publish = () =>
    run(async () => {
      // Publishing what is on screen, not what was last saved, is what an editor
      // expects — so the draft is flushed first.
      const saved = await adminSaveDraft(adminKey, pageId, blocks);
      setPage(await adminPublishPage(adminKey, pageId));
      setBlocks(saved.draft_blocks ?? blocks);
      setDirty(false);
      setRevisions(await adminListRevisions(adminKey, pageId));
    }, 'Published — the page is live.');

  const unpublish = () =>
    run(async () => {
      setPage(await adminUnpublishPage(adminKey, pageId));
    }, 'Unpublished. The built-in page is being served again.');

  const restore = (revisionId: string) =>
    run(async () => {
      const restored = await adminRestoreRevision(adminKey, pageId, revisionId);
      setBlocks(restored.draft_blocks ?? []);
      setDirty(false);
    }, 'Revision loaded into the draft. Publish it to make it live.');

  if (error && !page) return <div className="alert alert-error">{error}</div>;
  if (!page) return <p className="muted">Loading…</p>;

  const current = blocks[selected];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn btn-ghost small" onClick={onBack}>
          ← All pages
        </button>
        <h2 style={{ fontSize: '1.15rem', margin: 0 }}>{page.title}</h2>
        <span className={page.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
          {page.status}
        </span>
        <span className="small muted">/{page.slug === 'home' ? '' : page.slug}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
          <button className="btn btn-ghost" onClick={save} disabled={busy || !dirty}>
            {dirty ? 'Save draft' : 'Saved'}
          </button>
          <button className="btn btn-primary" onClick={publish} disabled={busy}>
            Publish
          </button>
          {page.status === 'published' && (
            <button className="btn btn-ghost" onClick={unpublish} disabled={busy}>
              Unpublish
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 2fr', gap: '1rem', marginTop: '1rem' }}>
        <div className="panel">
          <h3 style={{ fontSize: '1rem', marginTop: 0 }}>Blocks</h3>
          {blocks.length === 0 && <p className="small muted">This page is empty.</p>}
          {blocks.map((block, i) => (
            <div
              key={block.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.35rem 0.4rem',
                borderRadius: 6,
                background: i === selected ? 'var(--cream)' : undefined,
              }}
            >
              <button
                className="btn btn-ghost small"
                style={{ flex: 1, textAlign: 'left', border: 0 }}
                onClick={() => setSelected(i)}
              >
                {BLOCK_CATALOG[block.type]?.label ?? block.type}
              </button>
              <button className="btn btn-ghost small" title="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="btn btn-ghost small" title="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              <button
                className="btn btn-ghost small"
                title="Duplicate"
                onClick={() =>
                  update([
                    ...blocks.slice(0, i + 1),
                    { ...structuredClone(block), id: `b-${crypto.randomUUID()}` },
                    ...blocks.slice(i + 1),
                  ])
                }
              >
                ⧉
              </button>
              <button
                className="btn btn-ghost small"
                title="Delete"
                onClick={() => {
                  if (!window.confirm('Delete this block?')) return;
                  update(blocks.filter((_, j) => j !== i));
                  setSelected(0);
                }}
              >
                ✕
              </button>
            </div>
          ))}

          <button className="btn btn-primary small" style={{ marginTop: '0.7rem' }} onClick={() => setAdding(!adding)}>
            + Add block
          </button>
          {adding && (
            <div style={{ marginTop: '0.5rem' }}>
              {Object.entries(BLOCK_CATALOG).map(([type, spec]) => (
                <button
                  key={type}
                  className="btn btn-ghost small"
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '0.25rem' }}
                  title={spec.description}
                  onClick={() => {
                    update([...blocks, emptyBlock(type)]);
                    setSelected(blocks.length);
                    setAdding(false);
                  }}
                >
                  {spec.label}
                </button>
              ))}
            </div>
          )}

          {revisions.length > 0 && (
            <>
              <h3 style={{ fontSize: '1rem', marginTop: '1.2rem' }}>History</h3>
              {revisions.map((revision) => (
                <button
                  key={revision.id}
                  className="btn btn-ghost small"
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '0.2rem' }}
                  onClick={() => restore(revision.id)}
                >
                  {new Date(revision.created_at).toLocaleString()}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="panel">
          {current ? (
            <>
              <h3 style={{ fontSize: '1rem', marginTop: 0 }}>
                {BLOCK_CATALOG[current.type]?.label ?? current.type}
              </h3>
              <p className="small muted">{BLOCK_CATALOG[current.type]?.description}</p>
              <BlockPropsForm
                adminKey={adminKey}
                fields={BLOCK_CATALOG[current.type]?.fields ?? {}}
                values={current.props}
                onChange={(props) => update(blocks.map((b, i) => (i === selected ? { ...b, props } : b)))}
              />
            </>
          ) : (
            <p className="muted">Add a block to start building this page.</p>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: '1rem', padding: 0, overflow: 'hidden' }}>
        <p className="small muted" style={{ padding: '0.6rem 1rem', margin: 0, borderBottom: '1px solid var(--line)' }}>
          Preview — rendered with the same components the live site uses.
        </p>
        <BlockRenderer blocks={blocks} />
      </div>
    </>
  );
}

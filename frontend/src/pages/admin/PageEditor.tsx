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
 *
 * This component now delegates to the generic BlockEditor with a pages adapter,
 * keeping the same behavior as before the blog feature landed.
 */
import { useMemo } from 'react';
import BlockEditor, { type EditorAdapter } from './BlockEditor';
import {
  adminGetPage,
  adminSaveDraft,
  adminPublishPage,
  adminUnpublishPage,
  adminListRevisions,
  adminRestoreRevision,
  type AdminPage,
} from '../../lib/cms';

function usePagesAdapter(adminKey: string): EditorAdapter<AdminPage> {
  return useMemo(
    () => ({
      label: 'page',
      load: (pageId) => adminGetPage(adminKey, pageId),
      saveDraft: (pageId, blocks) => adminSaveDraft(adminKey, pageId, blocks),
      publish: (pageId) => adminPublishPage(adminKey, pageId),
      unpublish: (pageId) => adminUnpublishPage(adminKey, pageId),
      listRevisions: (pageId) => adminListRevisions(adminKey, pageId),
      restoreRevision: (pageId, revisionId) => adminRestoreRevision(adminKey, pageId, revisionId),
      headerTitle: (page) => `${page.title} — /${page.slug === 'home' ? '' : page.slug}`,
      publishNotice: 'Published — the page is live.',
    }),
    [adminKey],
  );
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
  const adapter = usePagesAdapter(adminKey);
  return (
    <BlockEditor
      adminKey={adminKey}
      resourceId={pageId}
      adapter={adapter}
      onBack={onBack}
      backLabel="All pages"
    />
  );
}

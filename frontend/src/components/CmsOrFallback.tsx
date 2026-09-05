/**
 * Serves a page from the CMS if it is published, and the original hardcoded
 * React page if it is not.
 *
 * This is the cutover mechanism: migrating a page means seeding its blocks and
 * pressing Publish, and un-migrating it means pressing Unpublish. Neither needs
 * a deploy, so a copy-fidelity problem found in production is one click from
 * being undone.
 *
 * Once every page has been live long enough to trust, this component and the
 * JSX pages it falls back to can be deleted, and the routes collapse onto the
 * `/:slug` catch-all in App.tsx.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getPage, type CmsPage } from '../lib/cms';
import BlockRenderer from '../cms/BlockRenderer';
import { useDocumentHead } from '../lib/useDocumentHead';

export default function CmsOrFallback({ slug, fallback }: { slug: string; fallback: ReactNode }) {
  const [page, setPage] = useState<CmsPage | null | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    getPage(slug)
      .then((p) => live && setPage(p))
      // Any failure — 404 because it isn't published, or the API being down —
      // lands on the hardcoded page. A CMS outage must not blank the site.
      .catch(() => live && setPage(null));
    return () => {
      live = false;
    };
  }, [slug]);

  // Only when the CMS page is actually live — the hardcoded fallback already
  // has its head baked into index.html / prerendered HTML, so overwriting it
  // here for the 'loading'/null cases would flash the wrong title.
  const publishedPage = page !== 'loading' && page !== null ? page : null;
  useDocumentHead({
    title: publishedPage ? publishedPage.seo_title || `${publishedPage.title} · Hilom Collective` : '',
    description: publishedPage?.seo_description,
    path: publishedPage ? `/${slug === 'home' ? '' : slug}` : undefined,
  });

  // The hardcoded page renders while the lookup is in flight, so there is no
  // blank frame during the request.
  if (page === 'loading' || page === null) return <>{fallback}</>;
  return <BlockRenderer blocks={page.blocks} />;
}

/**
 * Renders any published CMS page from its slug — the catch-all route that makes
 * "create a page in the admin and it exists on the site" true without a deploy.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPage, type CmsPage as Page } from '../lib/cms';
import BlockRenderer from '../cms/BlockRenderer';
import { Skeleton, SkeletonText, SkeletonMedia, SkeletonBoundary } from '../components/Skeleton';
import { useDocumentHead } from '../lib/useDocumentHead';

export default function CmsPage() {
  const { slug = '' } = useParams();
  const [page, setPage] = useState<Page | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    setState('loading');
    let live = true;
    getPage(slug)
      .then((p) => {
        if (!live) return;
        setPage(p);
        setState('ready');
      })
      .catch(() => live && setState('missing'));
    return () => {
      live = false;
    };
  }, [slug]);

  useDocumentHead({
    title: page ? page.seo_title || `${page.title} · Hilom Collective` : 'Hilom Collective',
    description: page?.seo_description,
    path: page ? `/${slug}` : undefined,
  });

  if (state === 'loading') {
    return (
      <section className="section">
        <SkeletonBoundary label="Loading page" className="container" style={{ display: 'grid', gap: '1.25rem' }}>
          <Skeleton height="2.6em" width="60%" />
          <SkeletonText lines={3} />
          <SkeletonMedia ratio="21 / 9" style={{ marginTop: '0.5rem' }} />
          <SkeletonText lines={3} />
        </SkeletonBoundary>
      </section>
    );
  }

  // A real 404 rather than a silent redirect to the homepage: a mistyped or
  // retired URL should say so, not pretend it was always the front page.
  if (state === 'missing' || !page) {
    return (
      <section className="section">
        <div className="container" style={{ textAlign: 'center' }}>
          <h1>Page not found</h1>
          <p className="lede">That page doesn't exist, or it isn't published yet.</p>
          <Link className="btn btn-primary" to="/">
            Back to home
          </Link>
        </div>
      </section>
    );
  }

  return <BlockRenderer blocks={page.blocks} />;
}

/**
 * Keeps the title, meta description, canonical link, and og/twitter tags in
 * sync during in-app (client-side) navigation.
 *
 * scripts/prerender.ts writes the same tags into the static HTML a crawler or
 * social scraper sees on first load, for the routes it knows about ahead of
 * time (blog posts, courses, facilitators). Neither a scraper nor a search
 * engine runs the SPA's JS, so this hook exists purely for humans: the tab
 * title and the tags Chrome/share-sheet read while navigating between pages
 * without a full reload, which React Router never does.
 */
import { useEffect } from 'react';

const SITE_URL = 'https://www.hilomcollective.com';

function setMetaByName(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setMetaByProperty(property: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('property', property);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(href: string) {
  let el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export interface DocumentHeadOptions {
  /** Full tab title, e.g. "Module 1: Understand Yourself — Hilom Collective". */
  title: string;
  description?: string | null;
  /** Path relative to the site root, e.g. `/courses/${slug}`, used for canonical + og:url. */
  path?: string;
  imageUrl?: string | null;
}

export function useDocumentHead({ title, description, path, imageUrl }: DocumentHeadOptions): void {
  useEffect(() => {
    if (!title) return;
    document.title = title;
    setMetaByProperty('og:title', title);
    setMetaByName('twitter:title', title);

    if (description) {
      setMetaByName('description', description);
      setMetaByProperty('og:description', description);
      setMetaByName('twitter:description', description);
    }

    if (path) {
      const url = `${SITE_URL}${path}`;
      setCanonical(url);
      setMetaByProperty('og:url', url);
    }

    if (imageUrl) {
      setMetaByProperty('og:image', imageUrl);
      setMetaByName('twitter:image', imageUrl);
    }
    // Deliberately no cleanup: the next page that mounts this hook overwrites
    // every tag itself, and a page that doesn't use it (nothing left to do
    // here) keeps whatever the previous route or the prerendered HTML set.
  }, [title, description, path, imageUrl]);
}

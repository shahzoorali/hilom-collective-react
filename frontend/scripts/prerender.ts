/**
 * Prerender script for head-only static HTML generation and sitemap generation.
 *
 * Runs during Amplify's postBuild phase after `vite build`.
 * Injects per-post / per-category <head> tags into copies of `dist/index.html`
 * so social scrapers (LinkedIn, WhatsApp, Facebook, Slack, etc.) and search engines
 * see real titles, descriptions, canonical URLs, og:images, and JSON-LD schema
 * without needing client-side JavaScript.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');
const SITE_URL = 'https://www.hilomcollective.com';
const API_BASE = process.env.VITE_API_BASE || 'https://api.hilomcollective.com';

interface Category {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  image_url: string | null;
  image_alt: string | null;
  author_name: string | null;
  author_image_url: string | null;
  category_id: string | null;
  tags: string[];
  published_at: string;
  seo_title?: string | null;
  seo_description?: string | null;
}

interface CmsPageSummary {
  slug: string;
  title: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createMetaTags({
  title,
  description,
  url,
  type = 'website',
  imageUrl,
  jsonLd,
}: {
  title: string;
  description: string;
  url: string;
  type?: 'website' | 'article';
  imageUrl?: string | null;
  jsonLd?: Record<string, unknown>;
}): string {
  const tags: string[] = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta property="og:site_name" content="Hilom Collective" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
  ];

  if (imageUrl) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
      `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
    );
  }

  if (jsonLd) {
    tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`);
  }

  return tags.join('\n    ');
}

function injectHead(template: string, headHtml: string): string {
  // Replace existing <title> and <meta name="description"> tags if present
  let html = template.replace(/<title>.*?<\/title>/is, '');
  html = html.replace(/<meta\s+name="description"\s+content=".*?"\s*\/?>/is, '');

  // Insert our custom head tags right before </head>
  return html.replace('</head>', `    ${headHtml}\n  </head>`);
}

async function writeRouteHtml(route: string, template: string, headHtml: string): Promise<void> {
  const targetDir = path.join(DIST_DIR, route);
  await fs.mkdir(targetDir, { recursive: true });
  const content = injectHead(template, headHtml);
  await fs.writeFile(path.join(targetDir, 'index.html'), content, 'utf8');
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[prerender] Warning: ${url} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[prerender] Warning: failed to fetch ${url}`, err);
    return null;
  }
}

async function main() {
  console.log('[prerender] Starting head-only prerender...');

  const indexPath = path.join(DIST_DIR, 'index.html');
  const template = await fs.readFile(indexPath, 'utf8');

  // Fetch published blog posts, categories, and CMS pages
  console.log(`[prerender] Fetching content from ${API_BASE}...`);
  const [categoriesData, postsData, pagesData] = await Promise.all([
    fetchJson<{ categories: Category[] }>(`${API_BASE}/categories`),
    fetchJson<{ posts: Post[]; total: number }>(`${API_BASE}/posts?page=1`),
    fetchJson<{ pages: CmsPageSummary[] }>(`${API_BASE}/pages`),
  ]);

  const categories = categoriesData?.categories ?? [];
  let allPosts: Post[] = postsData?.posts ?? [];

  // If there are more posts, fetch subsequent pages
  const totalPosts = postsData?.total ?? allPosts.length;
  const pageSize = 12;
  const totalPages = Math.ceil(totalPosts / pageSize);
  if (totalPages > 1) {
    for (let p = 2; p <= totalPages; p++) {
      const pageResult = await fetchJson<{ posts: Post[] }>(`${API_BASE}/posts?page=${p}`);
      if (pageResult?.posts) {
        allPosts = allPosts.concat(pageResult.posts);
      }
    }
  }

  const pages = pagesData?.pages ?? [];
  console.log(`[prerender] Found ${categories.length} categories, ${allPosts.length} posts, ${pages.length} pages.`);

  // 1. /blog
  console.log('[prerender] Prerendering /blog...');
  const blogHead = createMetaTags({
    title: 'Blog — Hilom Collective',
    description: 'Insights, practices, and stories on holistic healing and well-being.',
    url: `${SITE_URL}/blog`,
    type: 'website',
  });
  await writeRouteHtml('blog', template, blogHead);

  // 2. /blog/category/{slug}
  for (const cat of categories) {
    console.log(`[prerender] Prerendering /blog/category/${cat.slug}...`);
    const catHead = createMetaTags({
      title: `${cat.name} — Blog — Hilom Collective`,
      description: cat.description || `Articles and resources on ${cat.name} from Hilom Collective.`,
      url: `${SITE_URL}/blog/category/${cat.slug}`,
      type: 'website',
    });
    await writeRouteHtml(path.join('blog', 'category', cat.slug), template, catHead);
  }

  // 3. /blog/{slug}
  for (const post of allPosts) {
    console.log(`[prerender] Prerendering /blog/${post.slug}...`);
    const title = post.seo_title || `${post.title} — Hilom Collective`;
    const description = post.seo_description || post.excerpt || 'Read the full story on Hilom Collective.';
    const url = `${SITE_URL}/blog/${post.slug}`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      image: post.image_url || undefined,
      datePublished: post.published_at,
      author: post.author_name
        ? {
            '@type': 'Person',
            name: post.author_name,
            image: post.author_image_url || undefined,
          }
        : undefined,
      publisher: {
        '@type': 'Organization',
        name: 'Hilom Collective',
        url: SITE_URL,
      },
      mainEntityOfPage: {
        '@type': 'WebPage',
        '@id': url,
      },
    };

    const postHead = createMetaTags({
      title,
      description,
      url,
      type: 'article',
      imageUrl: post.image_url,
      jsonLd,
    });

    await writeRouteHtml(path.join('blog', post.slug), template, postHead);
  }

  // 4. Generate sitemap.xml
  console.log('[prerender] Generating sitemap.xml...');
  const sitemapUrls: { loc: string; lastmod?: string; changefreq: string; priority: string }[] = [
    { loc: `${SITE_URL}/`, changefreq: 'weekly', priority: '1.0' },
    { loc: `${SITE_URL}/about`, changefreq: 'monthly', priority: '0.8' },
    { loc: `${SITE_URL}/services`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/events`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/community`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/courses`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/blog`, changefreq: 'daily', priority: '0.9' },
  ];

  // Add CMS pages
  for (const page of pages) {
    if (!['home', 'about', 'services', 'events', 'community'].includes(page.slug)) {
      sitemapUrls.push({
        loc: `${SITE_URL}/${page.slug}`,
        changefreq: 'monthly',
        priority: '0.7',
      });
    }
  }

  // Add blog categories
  for (const cat of categories) {
    sitemapUrls.push({
      loc: `${SITE_URL}/blog/category/${cat.slug}`,
      changefreq: 'weekly',
      priority: '0.8',
    });
  }

  // Add blog posts
  for (const post of allPosts) {
    sitemapUrls.push({
      loc: `${SITE_URL}/blog/${post.slug}`,
      lastmod: post.published_at ? post.published_at.split('T')[0] : undefined,
      changefreq: 'monthly',
      priority: '0.8',
    });
  }

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls
  .map(
    (u) => `  <url>
    <loc>${escapeHtml(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  await fs.writeFile(path.join(DIST_DIR, 'sitemap.xml'), sitemapXml, 'utf8');
  console.log(`[prerender] Sitemap written with ${sitemapUrls.length} URLs.`);
  console.log('[prerender] Done!');
}

main().catch((err) => {
  console.error('[prerender] Fatal error:', err);
  process.exit(1);
});

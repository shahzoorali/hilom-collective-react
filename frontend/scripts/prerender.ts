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

interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_centavos: number;
  currency: string;
  thumbnail_url: string | null;
  image_url: string | null;
}

interface FacilitatorSummary {
  slug: string;
  display_name: string;
  headline: string | null;
  bio: string | null;
  photo_url: string | null;
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

  // Fetch published blog posts, categories, CMS pages, products, and facilitators
  console.log(`[prerender] Fetching content from ${API_BASE}...`);
  const [categoriesData, postsData, pagesData, productsData, facilitatorsData] = await Promise.all([
    fetchJson<{ categories: Category[] }>(`${API_BASE}/categories`),
    fetchJson<{ posts: Post[]; total: number }>(`${API_BASE}/posts?page=1`),
    fetchJson<{ pages: CmsPageSummary[] }>(`${API_BASE}/pages`),
    fetchJson<{ products: ProductSummary[] }>(`${API_BASE}/products`),
    fetchJson<{ facilitators: FacilitatorSummary[] }>(`${API_BASE}/facilitators`),
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
  const products = productsData?.products ?? [];
  const facilitators = facilitatorsData?.facilitators ?? [];
  console.log(
    `[prerender] Found ${categories.length} categories, ${allPosts.length} posts, ${pages.length} pages, ` +
      `${products.length} products, ${facilitators.length} facilitators.`,
  );

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

  // 4. /courses (list)
  console.log('[prerender] Prerendering /courses...');
  const coursesHead = createMetaTags({
    title: 'Courses — Hilom Collective',
    description: 'Self-paced online courses on emotional intelligence, resilience, and personal growth.',
    url: `${SITE_URL}/courses`,
    type: 'website',
  });
  await writeRouteHtml('courses', template, coursesHead);

  // 5. /courses/{slug}
  for (const product of products) {
    console.log(`[prerender] Prerendering /courses/${product.slug}...`);
    const title = `${product.name} — Hilom Collective`;
    const description =
      product.description || 'A self-paced online course from Hilom Collective, hosted on our learning platform.';
    const url = `${SITE_URL}/courses/${product.slug}`;
    const imageUrl = product.image_url || product.thumbnail_url;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Course',
      name: product.name,
      description,
      image: imageUrl || undefined,
      provider: {
        '@type': 'Organization',
        name: 'Hilom Collective',
        url: SITE_URL,
      },
      offers: {
        '@type': 'Offer',
        price: (product.price_centavos / 100).toFixed(2),
        priceCurrency: product.currency,
        url,
        availability: 'https://schema.org/InStock',
      },
    };

    const productHead = createMetaTags({
      title,
      description,
      url,
      type: 'website',
      imageUrl,
      jsonLd,
    });

    await writeRouteHtml(path.join('courses', product.slug), template, productHead);
  }

  // 6. /facilitators (list)
  console.log('[prerender] Prerendering /facilitators...');
  const facilitatorsHead = createMetaTags({
    title: 'Facilitators — Hilom Collective',
    description: 'Meet the facilitators offering 1:1 sessions and guided programs through Hilom Collective.',
    url: `${SITE_URL}/facilitators`,
    type: 'website',
  });
  await writeRouteHtml('facilitators', template, facilitatorsHead);

  // 7. /facilitators/{slug}
  for (const facilitator of facilitators) {
    console.log(`[prerender] Prerendering /facilitators/${facilitator.slug}...`);
    const title = `${facilitator.display_name} — Hilom Collective`;
    const description =
      facilitator.headline || facilitator.bio || `Book a session with ${facilitator.display_name} on Hilom Collective.`;
    const url = `${SITE_URL}/facilitators/${facilitator.slug}`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: facilitator.display_name,
      description,
      image: facilitator.photo_url || undefined,
      url,
    };

    const facilitatorHead = createMetaTags({
      title,
      description,
      url,
      type: 'website',
      imageUrl: facilitator.photo_url,
      jsonLd,
    });

    await writeRouteHtml(path.join('facilitators', facilitator.slug), template, facilitatorHead);
  }

  // 8. Generate sitemap.xml
  console.log('[prerender] Generating sitemap.xml...');
  const sitemapUrls: { loc: string; lastmod?: string; changefreq: string; priority: string }[] = [
    { loc: `${SITE_URL}/`, changefreq: 'weekly', priority: '1.0' },
    { loc: `${SITE_URL}/about`, changefreq: 'monthly', priority: '0.8' },
    { loc: `${SITE_URL}/services`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/events`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/community`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${SITE_URL}/courses`, changefreq: 'weekly', priority: '0.9' },
    { loc: `${SITE_URL}/facilitators`, changefreq: 'weekly', priority: '0.8' },
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

  // Add products (courses)
  for (const product of products) {
    sitemapUrls.push({
      loc: `${SITE_URL}/courses/${product.slug}`,
      changefreq: 'monthly',
      priority: '0.9',
    });
  }

  // Add facilitators
  for (const facilitator of facilitators) {
    sitemapUrls.push({
      loc: `${SITE_URL}/facilitators/${facilitator.slug}`,
      changefreq: 'monthly',
      priority: '0.7',
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

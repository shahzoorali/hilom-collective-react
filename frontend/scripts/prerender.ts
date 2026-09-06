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

interface KbCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  article_count?: number;
}

interface KbArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  kind: 'guide' | 'troubleshooting';
  audience: 'client' | 'facilitator' | 'both';
  tags: string[];
  seo_description: string | null;
  updated_at: string;
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
  noindex = false,
}: {
  title: string;
  description: string;
  url: string;
  type?: 'website' | 'article';
  imageUrl?: string | null;
  jsonLd?: Record<string, unknown>;
  /** Keep the page out of the index but still follow its links. */
  noindex?: boolean;
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

  if (noindex) {
    tags.push(`<meta name="robots" content="noindex, follow" />`);
  }

  return tags.join('\n    ');
}

/**
 * The breadcrumb trail a help page sits in, as structured data.
 *
 * Worth emitting where the article JSON-LD mostly is not: Google still renders
 * breadcrumbs in results, so a help article can show
 * "Help › Sessions & Booking" instead of a bare URL — which is exactly the
 * context that tells someone the result answers their question.
 */
function breadcrumbLd(trail: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
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
  const [categoriesData, postsData, pagesData, productsData, facilitatorsData, kbCategoriesData] =
    await Promise.all([
      fetchJson<{ categories: Category[] }>(`${API_BASE}/categories`),
      fetchJson<{ posts: Post[]; total: number }>(`${API_BASE}/posts?page=1`),
      fetchJson<{ pages: CmsPageSummary[] }>(`${API_BASE}/pages`),
      fetchJson<{ products: ProductSummary[] }>(`${API_BASE}/products`),
      fetchJson<{ facilitators: FacilitatorSummary[] }>(`${API_BASE}/facilitators`),
      fetchJson<{ categories: KbCategory[] }>(`${API_BASE}/kb/categories`),
    ]);

  // Help articles come one request per section rather than one per article —
  // the section endpoint carries everything the head tags need (see the note on
  // ARTICLE_LIST_COLUMNS in backend/src/handlers/kb.ts).
  const kbCategories = kbCategoriesData?.categories ?? [];
  const kbArticlesBySection = new Map<string, KbArticleSummary[]>();
  for (const section of kbCategories) {
    const result = await fetchJson<{ articles: KbArticleSummary[] }>(
      `${API_BASE}/kb/categories/${section.slug}`,
    );
    kbArticlesBySection.set(section.slug, result?.articles ?? []);
  }
  const kbArticleCount = [...kbArticlesBySection.values()].reduce((n, a) => n + a.length, 0);

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
      `${products.length} products, ${facilitators.length} facilitators, ` +
      `${kbCategories.length} help sections, ${kbArticleCount} help articles.`,
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

  // 8. Help centre.
  //
  // This section matters more than most of the ones above it. A help article is
  // typically reached by someone typing their problem into a search engine and
  // clicking the first plausible result — they rarely arrive via the hub. So the
  // per-article title and description here are doing the actual work of the help
  // centre being findable, and without them a crawler sees an empty SPA shell.
  console.log('[prerender] Prerendering /help...');
  const helpHead = createMetaTags({
    title: 'Help Centre — Hilom Collective',
    description:
      'Answers about courses, sessions, events, payments, and running your practice on Hilom Collective.',
    url: `${SITE_URL}/help`,
    type: 'website',
    jsonLd: breadcrumbLd([{ name: 'Help', url: `${SITE_URL}/help` }]),
  });
  await writeRouteHtml('help', template, helpHead);

  // /help/search is a real route, but a search-results page has nothing to
  // offer an index and would compete with the articles it lists. Prerendered
  // only so the noindex is there on first load, before any JS runs.
  await writeRouteHtml(
    path.join('help', 'search'),
    template,
    createMetaTags({
      title: 'Search help — Hilom Collective',
      description: 'Search the Hilom Collective help centre.',
      url: `${SITE_URL}/help/search`,
      type: 'website',
      noindex: true,
    }),
  );

  for (const section of kbCategories) {
    const sectionArticles = kbArticlesBySection.get(section.slug) ?? [];
    console.log(
      `[prerender] Prerendering /help/${section.slug} (${sectionArticles.length} articles)...`,
    );

    const sectionUrl = `${SITE_URL}/help/${section.slug}`;
    const sectionTrail = [
      { name: 'Help', url: `${SITE_URL}/help` },
      { name: section.name, url: sectionUrl },
    ];

    await writeRouteHtml(
      path.join('help', section.slug),
      template,
      createMetaTags({
        title: `${section.name} — Help — Hilom Collective`,
        description:
          section.description || `Help and answers about ${section.name} from Hilom Collective.`,
        url: sectionUrl,
        type: 'website',
        jsonLd: breadcrumbLd(sectionTrail),
      }),
    );

    for (const article of sectionArticles) {
      const url = `${sectionUrl}/${article.slug}`;
      const description =
        article.seo_description ||
        article.summary ||
        `${article.title} — help and answers from Hilom Collective.`;

      // TechArticle rather than Article: this is instructional support content,
      // which is what the type is for. It will not produce a rich result —
      // Google retired HowTo results and limited FAQPage ones — so this is here
      // for correct structured data, and the breadcrumb beside it is the part
      // that actually shows up in a result.
      const articleLd = {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: article.title,
        description,
        dateModified: article.updated_at,
        // No `author`: a help article is written by the organisation, and
        // inventing a person here would be a claim rather than a fact.
        publisher: { '@type': 'Organization', name: 'Hilom Collective', url: SITE_URL },
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        isPartOf: { '@type': 'WebPage', name: section.name, '@id': sectionUrl },
      };

      const head = [
        createMetaTags({
          title: `${article.title} — Help — Hilom Collective`,
          description,
          url,
          type: 'article',
          jsonLd: articleLd,
        }),
        `<script type="application/ld+json">${JSON.stringify(
          breadcrumbLd([...sectionTrail, { name: article.title, url }]),
        )}</script>`,
      ].join('\n    ');

      await writeRouteHtml(path.join('help', section.slug, article.slug), template, head);
    }
  }

  // 9. Generate sitemap.xml
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
    { loc: `${SITE_URL}/help`, changefreq: 'weekly', priority: '0.8' },
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

  // Add help sections and articles. `/help/search` is deliberately absent —
  // it carries a noindex, and listing a page in the sitemap while telling
  // crawlers not to index it is a contradiction worth not shipping.
  for (const section of kbCategories) {
    sitemapUrls.push({
      loc: `${SITE_URL}/help/${section.slug}`,
      changefreq: 'weekly',
      priority: '0.7',
    });
    for (const article of kbArticlesBySection.get(section.slug) ?? []) {
      sitemapUrls.push({
        loc: `${SITE_URL}/help/${section.slug}/${article.slug}`,
        // `lastmod` is the point of carrying `updated_at`: a help article that
        // is corrected needs recrawling, and this is how a crawler is told.
        lastmod: article.updated_at ? article.updated_at.split('T')[0] : undefined,
        changefreq: 'monthly',
        priority: '0.7',
      });
    }
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

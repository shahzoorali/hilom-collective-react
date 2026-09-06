/**
 * Help centre — hub, section and article pages, plus search.
 *
 * All three live in one file because they share the sidebar, the search box and
 * the breadcrumb, and splitting them would mean threading that shared state
 * through props or refetching the section list on every navigation.
 *
 * **The marketing grammar deliberately stops at the hub.** The rest of the site
 * is full-bleed alternating forest/white bands with an 86px hero — a layout for
 * someone who is browsing. Someone in the help centre is stuck and scanning for
 * one sentence, and colour bands behind a troubleshooting article are friction.
 * So the hub gets one forest band (with search as the hero, not decoration) and
 * everything below it is a reading surface: sidebar, narrow measure, no CTAs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  getKbArticle,
  getKbCategories,
  getKbCategory,
  markArticleHelpful,
  searchKb,
  AUDIENCE_LABELS,
  type KbArticle,
  type KbCategory,
  type KbSearchResult,
} from '../lib/kb';
import { renderHighlight, renderMarkdown, stripMarkdown } from '../lib/markdown';
import { useDocumentHead } from '../lib/useDocumentHead';

const SUPPORT_EMAIL = 'kumusta@hilomcollective.com';

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/**
 * The category list, fetched once and shared.
 *
 * Module-level rather than in a context provider: it is eight rows that change
 * when an admin edits them, and every page in this file needs it. A provider
 * would be more ceremony for the same result.
 */
let categoryCache: KbCategory[] | null = null;

function useCategories(): KbCategory[] {
  const [categories, setCategories] = useState<KbCategory[]>(categoryCache ?? []);

  useEffect(() => {
    if (categoryCache) return;
    let live = true;
    getKbCategories()
      .then((c) => {
        categoryCache = c;
        if (live) setCategories(c);
      })
      .catch(() => {
        // A failed sidebar must not take the article down with it — the reader
        // still gets what they came for, minus the navigation.
      });
    return () => {
      live = false;
    };
  }, []);

  return categories;
}

function SearchBox({
  autoFocus = false,
  initial = '',
  large = false,
}: {
  autoFocus?: boolean;
  initial?: string;
  large?: boolean;
}) {
  const [q, setQ] = useState(initial);
  const navigate = useNavigate();

  useEffect(() => setQ(initial), [initial]);

  return (
    <form
      className={large ? 'kb-search kb-search--large' : 'kb-search'}
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate(`/help/search?q=${encodeURIComponent(q.trim())}`);
      }}
      role="search"
    >
      <input
        type="search"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search for help…"
        aria-label="Search the help centre"
      />
      <button type="submit" className="btn btn-primary">
        Search
      </button>
    </form>
  );
}

function Sidebar({ activeSlug }: { activeSlug?: string }) {
  const categories = useCategories();
  if (categories.length === 0) return null;

  return (
    <nav className="kb-sidebar" aria-label="Help sections">
      <Link to="/help" className="kb-sidebar__home">
        All help
      </Link>
      <ul>
        {categories.map((c) => (
          <li key={c.id}>
            <Link
              to={`/help/${c.slug}`}
              className={c.slug === activeSlug ? 'is-active' : undefined}
              aria-current={c.slug === activeSlug ? 'page' : undefined}
            >
              {c.name}
              {typeof c.article_count === 'number' && (
                <span className="kb-sidebar__count">{c.article_count}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Breadcrumb({ trail }: { trail: { label: string; to?: string }[] }) {
  return (
    <nav className="kb-crumbs" aria-label="Breadcrumb">
      {trail.map((item, i) => (
        <span key={`${item.label}-${i}`}>
          {i > 0 && <span aria-hidden="true"> / </span>}
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span>{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

function StillStuck() {
  return (
    <div className="kb-stuck">
      <h2>Still stuck?</h2>
      <p>
        Tell us what you were trying to do and we'll pick it up from there.{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </div>
  );
}

/** One row in a list of articles — used by the hub, sections and search. */
function ArticleLink({ article, categorySlug }: { article: KbArticle; categorySlug: string }) {
  return (
    <li>
      <Link to={`/help/${categorySlug}/${article.slug}`}>
        <span className="kb-article-link__title">{article.title}</span>
        {article.summary && <span className="kb-article-link__summary">{article.summary}</span>}
      </Link>
    </li>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="kb-empty">
      <p>{message}</p>
      <Link to="/help">Back to the help centre</Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hub — /help
// ---------------------------------------------------------------------------

export function HelpHub() {
  const categories = useCategories();

  useDocumentHead({
    title: 'Help Centre — Hilom Collective',
    description:
      'Answers about courses, sessions, events, payments, and running your practice on Hilom Collective.',
    path: '/help',
  });

  return (
    <>
      <section className="kb-hero">
        <div className="container">
          <h1>How can we help?</h1>
          <SearchBox large autoFocus />
        </div>
      </section>

      <section className="container kb-hub">
        {categories.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="kb-hub__grid">
            {categories.map((c) => (
              <Link key={c.id} to={`/help/${c.slug}`} className="kb-hub__card">
                <h2>{c.name}</h2>
                {c.description && <p>{c.description}</p>}
                <span className="kb-hub__count">
                  {c.article_count ?? 0} article{c.article_count === 1 ? '' : 's'}
                </span>
              </Link>
            ))}
          </div>
        )}
        <StillStuck />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Section — /help/:categorySlug
// ---------------------------------------------------------------------------

export function HelpCategory() {
  const { categorySlug } = useParams<{ categorySlug: string }>();
  const [category, setCategory] = useState<KbCategory | null>(null);
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!categorySlug) return;
    setLoading(true);
    setError(null);
    getKbCategory(categorySlug)
      .then((r) => {
        setCategory(r.category);
        setArticles(r.articles);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [categorySlug]);

  useDocumentHead({
    title: category ? `${category.name} — Help — Hilom Collective` : 'Help — Hilom Collective',
    description: category?.description ?? undefined,
    path: categorySlug ? `/help/${categorySlug}` : undefined,
  });

  // Guides first, troubleshooting after: "how do I" and "why is this broken"
  // are different reading intents, and mixing them makes both harder to scan.
  const guides = articles.filter((a) => a.kind === 'guide');
  const troubleshooting = articles.filter((a) => a.kind === 'troubleshooting');

  return (
    <div className="container kb-layout">
      <Sidebar activeSlug={categorySlug} />
      <main className="kb-main">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : error || !category ? (
          <ErrorState message={error ?? 'That section does not exist.'} />
        ) : (
          <>
            <Breadcrumb trail={[{ label: 'Help', to: '/help' }, { label: category.name }]} />
            <h1>{category.name}</h1>
            {category.description && <p className="kb-lede">{category.description}</p>}
            <SearchBox />

            {articles.length === 0 ? (
              <p className="muted">There's nothing in this section yet.</p>
            ) : (
              <>
                <ul className="kb-article-list">
                  {guides.map((a) => (
                    <ArticleLink key={a.id} article={a} categorySlug={category.slug} />
                  ))}
                </ul>
                {troubleshooting.length > 0 && (
                  <>
                    <h2 className="kb-subhead">Troubleshooting</h2>
                    <ul className="kb-article-list">
                      {troubleshooting.map((a) => (
                        <ArticleLink key={a.id} article={a} categorySlug={category.slug} />
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            <StillStuck />
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Article — /help/:categorySlug/:articleSlug
// ---------------------------------------------------------------------------

export function HelpArticle() {
  const { categorySlug, articleSlug } = useParams<{
    categorySlug: string;
    articleSlug: string;
  }>();
  const [article, setArticle] = useState<KbArticle | null>(null);
  const [related, setRelated] = useState<KbArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voted, setVoted] = useState(false);

  useEffect(() => {
    if (!articleSlug) return;
    setLoading(true);
    setError(null);
    setVoted(false);
    getKbArticle(articleSlug)
      .then((r) => {
        setArticle(r.article);
        setRelated(r.related);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [articleSlug]);

  const rendered = useMemo(
    () => (article?.body ? renderMarkdown(article.body) : { html: '', toc: [] }),
    [article?.body],
  );

  useDocumentHead({
    title: article
      ? `${article.seo_title ?? article.title} — Help — Hilom Collective`
      : 'Help — Hilom Collective',
    description:
      article?.seo_description ??
      article?.summary ??
      (article?.body ? stripMarkdown(article.body) : undefined),
    path: categorySlug && articleSlug ? `/help/${categorySlug}/${articleSlug}` : undefined,
  });

  const category = article?.kb_categories;

  async function vote() {
    if (voted || !articleSlug) return;
    setVoted(true);
    await markArticleHelpful(articleSlug);
  }

  return (
    <div className="container kb-layout kb-layout--article">
      <Sidebar activeSlug={categorySlug} />

      <main className="kb-main kb-article">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : error || !article ? (
          <ErrorState message={error ?? 'That article does not exist.'} />
        ) : (
          <>
            <Breadcrumb
              trail={[
                { label: 'Help', to: '/help' },
                ...(category ? [{ label: category.name, to: `/help/${category.slug}` }] : []),
                { label: article.title },
              ]}
            />
            <h1>{article.title}</h1>
            {article.summary && <p className="kb-lede">{article.summary}</p>}
            {article.audience === 'facilitator' && (
              <p className="kb-audience-note">
                This article is for {AUDIENCE_LABELS.facilitator.toLowerCase()}.
              </p>
            )}

            {/* Safe by construction: renderMarkdown escapes the whole source
                before emitting any markup, so every tag here is one it wrote.
                See the note at the top of lib/markdown.ts. */}
            <div className="kb-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />

            <div className="kb-helpful">
              {voted ? (
                <p>Thanks — that helps us know what's working.</p>
              ) : (
                <>
                  <span>Was this helpful?</span>
                  <button className="btn btn-ghost" onClick={vote}>
                    Yes, thanks
                  </button>
                </>
              )}
            </div>

            {related.length > 0 && (
              <section className="kb-related">
                <h2>Related</h2>
                <ul className="kb-article-list">
                  {related.map((r) => (
                    <ArticleLink
                      key={r.id}
                      article={r}
                      categorySlug={r.kb_categories?.slug ?? categorySlug ?? ''}
                    />
                  ))}
                </ul>
              </section>
            )}

            <StillStuck />
          </>
        )}
      </main>

      {/* Only worth the column when there is enough structure to navigate. */}
      {rendered.toc.length > 2 && (
        <aside className="kb-toc" aria-label="On this page">
          <h2>On this page</h2>
          <ul>
            {rendered.toc.map((t) => (
              <li key={t.id} className={t.level === 3 ? 'is-nested' : undefined}>
                <a href={`#${t.id}`}>{t.text}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search — /help/search?q=
// ---------------------------------------------------------------------------

export function HelpSearch() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';

  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [broadened, setBroadened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against an out-of-order response overwriting a newer one when
  // someone searches twice quickly.
  const requestId = useRef(0);

  const run = useCallback((query: string) => {
    if (!query.trim()) {
      setResults([]);
      setBroadened(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    searchKb(query)
      .then((r) => {
        if (id !== requestId.current) return;
        setResults(r.results);
        setBroadened(r.broadened);
      })
      .catch((e: Error) => {
        if (id === requestId.current) setError(e.message);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    run(q);
  }, [q, run]);

  useDocumentHead({
    title: q ? `“${q}” — Help — Hilom Collective` : 'Search help — Hilom Collective',
    // Search results pages are not useful in an index, and having many of them
    // competing with the articles themselves is actively worse.
    description: 'Search the Hilom Collective help centre.',
  });

  return (
    <div className="container kb-layout">
      <Sidebar />
      <main className="kb-main">
        <Breadcrumb trail={[{ label: 'Help', to: '/help' }, { label: 'Search' }]} />
        <h1>Search</h1>
        <SearchBox initial={q} autoFocus />

        {loading ? (
          <p className="muted">Searching…</p>
        ) : error ? (
          <ErrorState message={error} />
        ) : !q.trim() ? (
          <p className="muted">Type what you're trying to do.</p>
        ) : results.length === 0 ? (
          <div className="kb-empty">
            <p>
              Nothing matched <strong>{q}</strong>.
            </p>
            <p className="muted">
              Try fewer words, or <Link to="/help">browse the sections</Link>.
            </p>
          </div>
        ) : (
          <>
            <p className="kb-result-count">
              {broadened
                ? `No article matches all of those words. Showing ${results.length} that match some of them.`
                : `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”.`}
            </p>
            <ul className="kb-results">
              {results.map((r) => (
                <li key={r.id}>
                  <Link to={`/help/${r.category_slug}/${r.slug}`}>
                    <span className="kb-results__title">{r.title}</span>
                    <span className="kb-results__where">{r.category_name}</span>
                  </Link>
                  {/* Escaped in renderHighlight; only [[hl]] becomes <mark>. */}
                  <p
                    className="kb-results__snippet"
                    dangerouslySetInnerHTML={{ __html: renderHighlight(r.headline) }}
                  />
                </li>
              ))}
            </ul>
          </>
        )}

        <StillStuck />
      </main>
    </div>
  );
}

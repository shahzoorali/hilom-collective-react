/**
 * The facilitator's view of the Help Centre.
 *
 * No content of its own: it lists the published Help Centre articles meant for
 * facilitators (audience `facilitator` or `both`), so an admin editing an
 * article in Admin → Help Centre updates this tab, /help and the welcome email
 * at once. Articles open on the public /help pages in a new tab, so reading a
 * guide never loses the form a facilitator is halfway through.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  getKbCategories,
  getKbCategory,
  searchKb,
  type KbArticle,
  type KbCategory,
  type KbSearchResult,
} from '../../lib/kb';

interface Group {
  category: KbCategory;
  articles: KbArticle[];
}

/** The category facilitators need most goes first; the rest keep the Help Centre's order. */
const FIRST = 'for-facilitators';

export const helpArticleUrl = (categorySlug: string, articleSlug: string) => `/help/${categorySlug}/${articleSlug}`;

export default function HelpTab() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const categories = (await getKbCategories()).filter((c) => (c.article_count ?? 1) > 0);
      const loaded = await Promise.all(
        categories.map(async (category) => {
          const { articles } = await getKbCategory(category.slug);
          return { category, articles: articles.filter((a) => a.audience !== 'client') };
        }),
      );
      const withArticles = loaded.filter((g) => g.articles.length > 0);
      withArticles.sort((a, b) =>
        a.category.slug === FIRST ? -1 : b.category.slug === FIRST ? 1 : a.category.position - b.category.position,
      );
      if (!cancelled) setGroups(withArticles);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const { results: found } = await searchKb(q, 'facilitator');
      setResults(found);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="fs-page">
      <header className="fs-pagehead">
        <div>
          <h1>Help</h1>
          <p>
            Step-by-step guides for running your practice on Hilom: your profile, services,
            bookings, events, classes and payouts.
          </p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={onSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <input
          type="search"
          className="input"
          placeholder="Search the guides — e.g. payouts, reschedule, group class"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setResults(null);
          }}
          style={{ flex: 1 }}
          aria-label="Search the guides"
        />
        <button type="submit" className="btn btn-primary" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {results !== null ? (
        <section className="card" style={{ padding: '1rem 1.25rem' }}>
          <h2 style={{ marginTop: 0 }}>Results</h2>
          {results.length === 0 ? (
            <p className="muted">
              Nothing matched. Try a different word, or <ContactLink />.
            </p>
          ) : (
            <ArticleList
              items={results.map((r) => ({ key: r.id, title: r.title, summary: r.summary, href: helpArticleUrl(r.category_slug, r.slug) }))}
            />
          )}
        </section>
      ) : groups === null ? (
        !error && <div className="spinner" aria-label="Loading" />
      ) : (
        groups.map((g) => (
          <section key={g.category.id} className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
            <h2 style={{ marginTop: 0 }}>{g.category.name}</h2>
            <ArticleList
              items={g.articles.map((a) => ({
                key: a.id,
                title: a.title,
                summary: a.summary,
                href: helpArticleUrl(g.category.slug, a.slug),
              }))}
            />
          </section>
        ))
      )}

      <p className="small muted">
        Can't find what you need? <ContactLink />.
      </p>
    </div>
  );
}

function ArticleList({ items }: { items: { key: string; title: string; summary: string | null; href: string }[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((a) => (
        <li key={a.key} style={{ padding: '0.5rem 0', borderTop: '1px solid var(--line, rgba(0,0,0,0.08))' }}>
          <a href={a.href} target="_blank" rel="noreferrer">
            <strong>{a.title}</strong> ↗
          </a>
          {a.summary && <div className="small muted">{a.summary}</div>}
        </li>
      ))}
    </ul>
  );
}

function ContactLink() {
  return <a href="mailto:hello@hilomcollective.com">email hello@hilomcollective.com</a>;
}

/**
 * The guides behind each dashboard tab, shown as a "How does this work?" line
 * above it. Slugs are Help Centre articles in `for-facilitators`; an article
 * renamed there needs updating here.
 */
const CONTEXT_HELP: Record<string, { title: string; slug: string }[]> = {
  bookings: [
    { title: 'Managing your bookings', slug: 'managing-your-bookings' },
    { title: 'Suggesting a new time', slug: 'suggesting-a-new-time' },
    { title: 'Cancellations and no-shows', slug: 'cancellations-and-no-shows' },
  ],
  clients: [{ title: 'Your clients and session notes', slug: 'your-clients' }],
  events: [
    { title: 'Proposing an event', slug: 'proposing-an-event' },
    { title: 'Proposing a series', slug: 'proposing-a-series' },
    { title: 'Hosting an event', slug: 'hosting-an-event' },
  ],
  classes: [
    { title: 'Running group classes', slug: 'running-group-classes' },
    { title: 'Cancelling a class date', slug: 'cancelling-a-class-date' },
  ],
  services: [
    { title: 'Creating your services', slug: 'creating-your-services' },
    { title: 'Selling packages', slug: 'selling-packages' },
    { title: 'Your cancellation terms', slug: 'your-cancellation-terms' },
  ],
  availability: [
    { title: 'Setting your availability', slug: 'setting-your-availability' },
    { title: 'Taking time off', slug: 'time-off' },
    { title: 'Your calendar feed', slug: 'your-calendar-feed' },
  ],
  profile: [
    { title: 'Setting up your profile', slug: 'setting-up-your-profile' },
    { title: 'Going live in the directory', slug: 'going-live' },
  ],
  connections: [
    { title: 'Connecting your video account', slug: 'connecting-your-video-account' },
    { title: 'My video account disconnected', slug: 'video-account-disconnected' },
  ],
  earnings: [{ title: 'Earnings and payouts', slug: 'earnings-and-payouts' }],
};

/** "How does this work?" links for the current tab; renders nothing for tabs without guides. */
export function ContextHelp({ tab }: { tab: string }) {
  const articles = CONTEXT_HELP[tab];
  if (!articles) return null;
  return (
    <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
      <span aria-hidden="true">💡</span> How does this work?{' '}
      {articles.map((a, i) => (
        <span key={a.slug}>
          {i > 0 && ' · '}
          <a href={helpArticleUrl(FIRST, a.slug)} target="_blank" rel="noreferrer">
            {a.title}
          </a>
        </span>
      ))}
    </p>
  );
}

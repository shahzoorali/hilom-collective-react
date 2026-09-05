/**
 * Blog listing page — paginated, filterable by category or tag.
 *
 * Category pages have their own route (/blog/category/:categorySlug) and are
 * prerendered for SEO. Tag filtering is a query parameter — not worth
 * prerendering every combination.
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getPosts, getCategories, type BlogPost, type BlogCategory, type BlogListResponse } from '../lib/cms';
import { SkeletonCardGrid } from '../components/Skeleton';

export default function Blog() {
  const { categorySlug } = useParams<{ categorySlug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tag = searchParams.get('tag') ?? undefined;
  const pageParam = parseInt(searchParams.get('page') ?? '1', 10);

  const [data, setData] = useState<BlogListResponse | null>(null);
  const [categories, setCategories] = useState<BlogCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getPosts({ page: pageParam, category: categorySlug, tag })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [categorySlug, tag, pageParam]);

  // Set document title.
  useEffect(() => {
    const parts = ['Blog'];
    const activeCat = categories.find((c) => c.slug === categorySlug);
    if (activeCat) parts.push(activeCat.name);
    if (tag) parts.push(`#${tag}`);
    parts.push('Hilom Collective');
    document.title = parts.join(' — ');
  }, [categorySlug, tag, categories]);

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  function setPage(p: number) {
    const params = new URLSearchParams(searchParams);
    if (p > 1) params.set('page', String(p));
    else params.delete('page');
    setSearchParams(params);
  }

  return (
    <section className="cv-band cv-band--white">
      <div className="container">
        <h1 className="blog-heading">
          {categorySlug
            ? categories.find((c) => c.slug === categorySlug)?.name ?? 'Blog'
            : tag
              ? `Posts tagged "${tag}"`
              : 'Blog'}
        </h1>

        {/* Category pills */}
        {categories.length > 0 && (
          <div className="blog-categories">
            <Link
              to="/blog"
              className={!categorySlug && !tag ? 'pill pill-ok' : 'pill'}
            >
              All
            </Link>
            {categories.map((cat) => (
              <Link
                key={cat.id}
                to={`/blog/category/${cat.slug}`}
                className={categorySlug === cat.slug ? 'pill pill-ok' : 'pill'}
              >
                {cat.name}
              </Link>
            ))}
          </div>
        )}

        {loading && <SkeletonCardGrid count={6} className="blog-grid" style={{ marginTop: '2rem' }} />}
        {error && <div className="alert alert-error">{error}</div>}

        {data && data.posts.length === 0 && !loading && (
          <p className="muted">No posts yet.</p>
        )}

        {data && data.posts.length > 0 && (
          <>
            <div className="blog-grid">
              {data.posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="blog-pagination">
                <button
                  className="btn btn-ghost small"
                  disabled={pageParam <= 1}
                  onClick={() => setPage(pageParam - 1)}
                >
                  ← Previous
                </button>
                <span className="small muted">
                  Page {pageParam} of {totalPages}
                </span>
                <button
                  className="btn btn-ghost small"
                  disabled={pageParam >= totalPages}
                  onClick={() => setPage(pageParam + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PostCard({ post }: { post: BlogPost }) {
  return (
    <Link to={`/blog/${post.slug}`} className="blog-card">
      {post.image_url && (
        <div className="blog-card__image">
          <img src={post.image_url} alt={post.image_alt ?? ''} loading="lazy" />
        </div>
      )}
      <div className="blog-card__body">
        {post.categories && (
          <span className="blog-card__category">{post.categories.name}</span>
        )}
        <h2 className="blog-card__title">{post.title}</h2>
        {post.excerpt && <p className="blog-card__excerpt">{post.excerpt}</p>}
        <div className="blog-card__meta">
          {post.author_name && <span>{post.author_name}</span>}
          <time dateTime={post.published_at}>
            {new Date(post.published_at).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </time>
        </div>
      </div>
    </Link>
  );
}

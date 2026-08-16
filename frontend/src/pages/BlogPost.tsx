/**
 * Single blog post page.
 *
 * Renders the post cover, byline, Puck block body via BlockRenderer, tags,
 * and a related-posts strip. Sets document.title and meta description for
 * in-app navigation (prerendered head covers the initial load for scrapers).
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPost, type BlogPostDetail, type BlogPost } from '../lib/cms';
import BlockRenderer from '../cms/BlockRenderer';

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const [post, setPost] = useState<BlogPostDetail | null>(null);
  const [related, setRelated] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    getPost(slug)
      .then((r) => {
        setPost(r.post);
        setRelated(r.related);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug]);

  // Update document title + meta description for in-app navigation.
  useEffect(() => {
    if (!post) return;
    document.title = `${post.seo_title ?? post.title} — Hilom Collective`;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && (post.seo_description ?? post.excerpt)) {
      metaDesc.setAttribute('content', post.seo_description ?? post.excerpt ?? '');
    }
  }, [post]);

  if (loading) return <section className="section"><div className="container"><p className="muted">Loading…</p></div></section>;
  if (error) return <section className="section"><div className="container"><div className="alert alert-error">{error}</div></div></section>;
  if (!post) return <section className="section"><div className="container"><p className="muted">Post not found.</p></div></section>;

  return (
    <>
      <article className="blog-post">
        {/* Cover image */}
        {post.image_url && (
          <div className="blog-post__cover">
            <img src={post.image_url} alt={post.image_alt ?? ''} />
          </div>
        )}

        <div className="container blog-post__container">
          {/* Category + title */}
          {post.categories && (
            <Link to={`/blog/category/${post.categories.slug}`} className="blog-post__category">
              {post.categories.name}
            </Link>
          )}
          <h1 className="blog-post__title">{post.title}</h1>

          {/* Byline */}
          <div className="blog-post__byline">
            {post.author_image_url && (
              <img
                src={post.author_image_url}
                alt={post.author_name ?? ''}
                className="blog-post__author-photo"
              />
            )}
            <div>
              {post.author_name && <span className="blog-post__author-name">{post.author_name}</span>}
              <time dateTime={post.published_at} className="blog-post__date">
                {new Date(post.published_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
            </div>
          </div>

          {/* Post body (Puck blocks) */}
          <div className="blog-post__body">
            <BlockRenderer blocks={post.blocks} />
          </div>

          {/* Tags */}
          {post.tags.length > 0 && (
            <div className="blog-post__tags">
              {post.tags.map((tag) => (
                <Link key={tag} to={`/blog?tag=${encodeURIComponent(tag)}`} className="pill">
                  #{tag}
                </Link>
              ))}
            </div>
          )}
        </div>
      </article>

      {/* Related posts */}
      {related.length > 0 && (
        <section className="section blog-related">
          <div className="container">
            <h2 className="blog-related__heading">Related Posts</h2>
            <div className="blog-grid blog-grid--related">
              {related.map((r) => (
                <Link key={r.id} to={`/blog/${r.slug}`} className="blog-card">
                  {r.image_url && (
                    <div className="blog-card__image">
                      <img src={r.image_url} alt={r.image_alt ?? ''} loading="lazy" />
                    </div>
                  )}
                  <div className="blog-card__body">
                    <h3 className="blog-card__title">{r.title}</h3>
                    {r.excerpt && <p className="blog-card__excerpt">{r.excerpt}</p>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

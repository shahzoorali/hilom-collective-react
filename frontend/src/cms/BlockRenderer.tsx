/**
 * Renders CMS blocks using the site's existing markup and CSS classes.
 *
 * Every component here was lifted from the hardcoded page it replaces
 * (Home.tsx, About.tsx, Services.tsx, Events.tsx), so a migrated page renders
 * identically to the JSX version — that equivalence is what makes the cutover
 * in CmsOrFallback safe to flip and unflip.
 *
 * The admin preview renders through this same component, so "what you see" in
 * the editor cannot drift from what ships.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listProducts, type Product } from '../lib/api';
import { getEvents, type CmsEvent } from '../lib/cms';
import { money } from '../components/Layout';
import type { Block, Cta, MediaRef } from './blocks';
import CommunityForm from './CommunityForm';
import FormBlock from './FormBlock';

type Props = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Props[] => (Array.isArray(v) ? (v as Props[]) : []);
const media = (v: unknown): MediaRef | undefined =>
  v && typeof v === 'object' && 'url' in (v as object) ? (v as MediaRef) : undefined;
const cta = (v: unknown): Cta | undefined => (v && typeof v === 'object' ? (v as Cta) : undefined);

function sectionStyle(props: Props, extra?: CSSProperties): CSSProperties {
  return props.background === 'cream' ? { background: 'var(--cream)', ...extra } : { ...extra };
}

/** Internal paths route through react-router; anything else is a real link. */
function CtaLink({ value }: { value: Cta | undefined }) {
  if (!value?.label || !value.href) return null;
  const className = `btn ${value.variant ?? 'btn-primary'}`;
  return value.href.startsWith('/') ? (
    <Link className={className} to={value.href}>
      {value.label}
    </Link>
  ) : (
    <a className={className} href={value.href} target="_blank" rel="noreferrer">
      {value.label}
    </a>
  );
}

/** Rich text is sanitized server-side on save, so what reaches here is already
 *  an allowlisted subset of HTML. */
function RichText({ html }: { html: string }) {
  if (!html) return null;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function Badge({ props }: { props: Props }) {
  if (!props.badge) return null;
  return (
    <p className="badge" style={props.badgeColor === 'ochre' ? { background: 'var(--ochre)' } : undefined}>
      {str(props.badge)}
    </p>
  );
}

function Hero({ props }: { props: Props }) {
  const lede = Array.isArray(props.lede) ? props.lede : [];
  return (
    <section className="hero">
      <div className="container">
        <Badge props={props} />
        <h1>{str(props.heading)}</h1>
        {lede.map((line, i) => (
          <p
            className="lede"
            key={i}
            // The homepage's first lede line is bold and forest-coloured.
            style={i === 0 && props.emphasizeFirstLede ? { fontWeight: 600, color: 'var(--forest)' } : undefined}
          >
            {String(line)}
          </p>
        ))}
        <CtaLink value={cta(props.cta)} />
      </div>
    </section>
  );
}

function FullWidthImage({ props }: { props: Props }) {
  const image = media(props.image);
  if (!image) return null;
  return (
    <div className="container">
      <img
        src={image.url}
        alt={image.alt}
        style={{ width: '100%', borderRadius: 'var(--radius)', margin: '2rem 0', display: 'block' }}
      />
    </div>
  );
}

function RichTextSection({ props }: { props: Props }) {
  return (
    <section className="section" style={sectionStyle(props)}>
      <div className="container">
        <RichText html={str(props.html)} />
      </div>
    </section>
  );
}

function Split({ props }: { props: Props }) {
  const image = media(props.image);
  const heading = str(props.heading);
  const copy = (
    <div>
      <Badge props={props} />
      {heading ? props.headingLevel === 'h1' ? <h1>{heading}</h1> : <h2>{heading}</h2> : null}
      <RichText html={str(props.html)} />
      <CtaLink value={cta(props.cta)} />
    </div>
  );
  const picture = image ? (
    <img src={image.url} alt={image.alt} style={{ width: '100%', borderRadius: 'var(--radius)' }} />
  ) : null;

  const classes = ['container', 'split'];
  if (props.reverse) classes.push('split-reverse');
  if (props.narrow) classes.push('split-narrow');

  return (
    <section className="section" style={sectionStyle(props)}>
      <div className={classes.join(' ')}>
        {/* split-reverse puts the image first in the DOM, matching the
            hardcoded Home.tsx markup it replaces. */}
        {props.reverse ? (
          <>
            {picture}
            {copy}
          </>
        ) : (
          <>
            {copy}
            {picture}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Counts up to the target when scrolled into view. Ported from Home.tsx rather
 * than simplified: the animation is part of how the homepage reads now, and a
 * migrated page that rendered static numbers would be a visible regression.
 */
function StatCounter({ value, caption }: { value: string; caption: string }) {
  const [displayValue, setDisplayValue] = useState(value);
  const [hasAnimated, setHasAnimated] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          setHasAnimated(true);

          const numMatch = value.match(/[\d.]+/);
          if (!numMatch) return;

          const targetNum = parseFloat(numMatch[0]);
          const suffix = value.replace(numMatch[0], '');
          const duration = 1000;
          const startTime = Date.now();

          const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOutQuad = 1 - Math.pow(1 - progress, 2);
            const current = targetNum * easeOutQuad;

            setDisplayValue(current.toFixed(numMatch[0].includes('.') ? 1 : 0) + suffix);

            if (progress < 1) requestAnimationFrame(animate);
          };

          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value, hasAnimated]);

  return (
    <div ref={ref} className="panel" style={{ textAlign: 'left' }}>
      <p style={{ fontFamily: 'var(--serif)', fontSize: '2.4rem', fontWeight: 700, color: 'var(--ochre)', margin: '0 0 0.4rem' }}>
        {displayValue}
      </p>
      <p className="small" style={{ margin: 0 }}>
        {caption}
      </p>
    </div>
  );
}

function StatGrid({ props }: { props: Props }) {
  return (
    <section className="section" style={sectionStyle(props)}>
      <div className="container">
        <Badge props={props} />
        {props.heading ? <h2>{str(props.heading)}</h2> : null}
        <div className="grid" style={{ marginTop: '1.5rem' }}>
          {list(props.items).map((item, i) => (
            <StatCounter key={i} value={str(item.value)} caption={str(item.caption)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CardGrid({ props }: { props: Props }) {
  return (
    <section className="section" style={sectionStyle(props)}>
      <div className="container">
        {props.heading ? <h2>{str(props.heading)}</h2> : null}
        {props.subheading ? <p className="muted">{str(props.subheading)}</p> : null}
        <div className="grid" style={{ marginTop: '1.5rem' }}>
          {list(props.items).map((item, i) => (
            <div className="card" key={i}>
              {item.title ? <h3>{str(item.title)}</h3> : null}
              <p className="desc" style={item.title ? undefined : { margin: 0 }}>
                {str(item.body)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PanelGrid({ props }: { props: Props }) {
  return (
    <section className="section" style={sectionStyle(props)}>
      <div className="container grid two-col">
        {list(props.items).map((item, i) => (
          <div className="panel" key={i}>
            {item.badge ? <p className="badge">{str(item.badge)}</p> : null}
            <p style={{ marginBottom: 0 }}>{str(item.body)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ImageCardGrid({ props }: { props: Props }) {
  // Services use landscape cards, events portrait ones — the only difference
  // between the two card styles on the live site.
  const isEvent = props.variant === 'event';
  const aspectRatio = isEvent ? '4/5' : '4/3';

  return (
    <section className="section" style={sectionStyle(props, { paddingTop: 0 })}>
      <div className="container grid">
        {list(props.items).map((item, i) => {
          const image = media(item.image);
          return (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }} key={i}>
              {image ? (
                <img src={image.url} alt={image.alt} style={{ width: '100%', aspectRatio, objectFit: 'cover' }} />
              ) : null}
              <div style={{ padding: '1.4rem' }}>
                <h3>{str(item.title)}</h3>
                {item.subtitle ? (
                  <p
                    className={isEvent ? 'small muted' : 'small'}
                    style={isEvent ? { marginBottom: '0.5rem' } : { fontWeight: 600, color: 'var(--forest)' }}
                  >
                    {str(item.subtitle)}
                  </p>
                ) : null}
                {item.desc ? <p className="desc">{str(item.desc)}</p> : null}
                {item.meta ? (
                  <p className="small" style={{ fontWeight: 600, color: 'var(--forest)' }}>
                    {str(item.meta)}
                  </p>
                ) : null}
                {item.note ? (
                  <p className="small" style={{ color: 'var(--ochre-dark)', fontWeight: 600 }}>
                    {str(item.note)}
                  </p>
                ) : null}
                <CtaLink value={cta(item.cta)} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The one block backed by live data rather than authored content. */
function ProductGrid({ props }: { props: Props }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProducts()
      .then(setProducts)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section className="section" style={sectionStyle(props)}>
      <div className="container">
        {props.heading ? <h2>{str(props.heading)}</h2> : null}
        {props.subheading ? <p className="muted">{str(props.subheading)}</p> : null}
        {error && <div className="alert alert-error">Couldn't load courses: {error}</div>}
        {!products && !error && <p className="muted">Loading…</p>}
        {products && (
          <div className="grid" style={{ marginTop: '1.5rem' }}>
            {products.map((p) => (
              <article className="card" key={p.id}>
                {p.slug.includes('bundle') && <span className="badge">Bundle</span>}
                <h3>{p.name}</h3>
                <p className="desc">{p.description}</p>
                <div className="price">{money(p.price_centavos, p.currency)}</div>
                <Link className="btn btn-primary" to={`/courses/${p.slug}`}>
                  View details
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** "July 22, 2026 | 3:00–5:00 PM | Via Zoom" — same reading order as the
 *  hand-authored cards this block replaces, built from real Date objects
 *  instead of typed-out text. Asia/Manila: the site's audience and every
 *  event to date are Philippines-timed regardless of a visitor's own locale. */
function formatEventWhen(startsAt: string, endsAt: string | null, location: string | null): string {
  const start = new Date(startsAt);
  const tz = 'Asia/Manila';
  const date = new Intl.DateTimeFormat('en-PH', { dateStyle: 'long', timeZone: tz }).format(start);
  const time = new Intl.DateTimeFormat('en-PH', { timeStyle: 'short', timeZone: tz });
  const timeRange = endsAt ? `${time.format(start)}–${time.format(new Date(endsAt))}` : time.format(start);
  return [date, timeRange, location].filter(Boolean).join(' | ');
}

function EventCard({ event, past }: { event: CmsEvent; past: boolean }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', opacity: past ? 0.75 : undefined }}>
      {event.image_url ? (
        <img
          src={event.image_url}
          alt={event.image_alt ?? ''}
          style={{ width: '100%', aspectRatio: '4/5', objectFit: 'cover' }}
        />
      ) : null}
      <div style={{ padding: '1.4rem' }}>
        <h3>{event.title}</h3>
        {event.subtitle ? (
          <p className="small muted" style={{ marginBottom: '0.5rem' }}>
            {event.subtitle}
          </p>
        ) : null}
        {event.description ? <RichText html={event.description} /> : null}
        <p className="small" style={{ fontWeight: 600, color: 'var(--forest)' }}>
          {formatEventWhen(event.starts_at, event.ends_at, event.location)}
        </p>
        {event.note ? (
          <p className="small" style={{ color: 'var(--ochre-dark)', fontWeight: 600 }}>
            {event.note}
          </p>
        ) : null}
        {event.link_url && event.link_label ? (
          <CtaLink value={{ label: event.link_label, href: event.link_url, variant: 'btn-primary' }} />
        ) : null}
      </div>
    </div>
  );
}

/** The other block backed by live data — see ProductGrid above. Individual
 *  events are managed at Admin → Events, not authored as block props, so
 *  there is nothing here for the block editor to configure per-item. */
function EventGrid({ props }: { props: Props }) {
  const [data, setData] = useState<{ upcoming: CmsEvent[]; past: CmsEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEvents()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section className="section" style={sectionStyle(props, { paddingTop: 0 })}>
      <div className="container">
        {props.heading ? <h2>{str(props.heading)}</h2> : null}
        {error && <div className="alert alert-error">Couldn't load events: {error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && data.upcoming.length === 0 && data.past.length === 0 && (
          <p className="muted">No events scheduled right now — check back soon.</p>
        )}
        {data && data.upcoming.length > 0 && (
          <div className="grid" style={{ marginTop: '1.5rem' }}>
            {data.upcoming.map((event) => (
              <EventCard event={event} past={false} key={event.id} />
            ))}
          </div>
        )}
        {data && data.past.length > 0 && (
          <>
            <h2 style={{ marginTop: '2.5rem' }}>Past Events</h2>
            <div className="grid" style={{ marginTop: '1.5rem' }}>
              {data.past.map((event) => (
                <EventCard event={event} past key={event.id} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function CtaBanner({ props }: { props: Props }) {
  return (
    <section className="section" style={sectionStyle(props, { textAlign: 'center' })}>
      <div className="container">
        <Badge props={props} />
        <h2>{str(props.heading)}</h2>
        {props.lede ? (
          <p className="lede" style={{ margin: '0 auto 1.5rem' }}>
            {str(props.lede)}
          </p>
        ) : null}
        <CtaLink value={cta(props.cta)} />
      </div>
    </section>
  );
}

function CommunityFormBlock() {
  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="container" style={{ maxWidth: 640 }}>
        <CommunityForm />
      </div>
    </section>
  );
}

/**
 * type -> component. Exported so the Puck editor renders the same components
 * the live site does, rather than an editor-only approximation of them.
 */
export const BLOCK_COMPONENTS: Record<string, (p: { props: Props }) => ReactNode> = {
  hero: Hero,
  fullWidthImage: FullWidthImage,
  richText: RichTextSection,
  split: Split,
  statGrid: StatGrid,
  cardGrid: CardGrid,
  panelGrid: PanelGrid,
  imageCardGrid: ImageCardGrid,
  productGrid: ProductGrid,
  eventGrid: EventGrid,
  ctaBanner: CtaBanner,
  communityForm: CommunityFormBlock,
  form: ({ props }) => <FormBlock slug={str(props.formSlug)} heading={str(props.heading)} />,
};

export default function BlockRenderer({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block) => {
        const Component = BLOCK_COMPONENTS[block.type];
        // An unknown type renders nothing rather than throwing: an older
        // frontend must not white-screen on content authored against a newer
        // block catalog.
        if (!Component) {
          if (import.meta.env.DEV) console.warn(`[cms] no renderer for block type "${block.type}"`);
          return null;
        }
        return <Component key={block.id} props={block.props} />;
      })}
    </>
  );
}

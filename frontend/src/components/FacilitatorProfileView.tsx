/**
 * The public facilitator profile, as markup.
 *
 * Split out of `pages/FacilitatorProfile.tsx` so the admin profile editor can
 * render the *same* component rather than an approximation of it. A preview
 * built from a copy of this markup would drift the first time either side was
 * touched, and an editor that shows something other than what visitors will
 * see is worse than no preview at all.
 *
 * Purely presentational: it takes an already-loaded profile and does no
 * fetching, no `useParams`, and no document-head work. Loading, errors and SEO
 * stay with the page; `preview` is the one behavioural difference, and it only
 * neutralises the booking buttons — inside the editor they would lead a
 * *client* booking flow off an unsaved draft.
 */
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { displayPrice } from './Layout';
import {
  describeRefundPolicy,
  formatDuration,
  type Facilitator,
  type FacilitatorService,
  type PublicReview,
  type RatingSummary,
} from '../lib/booking';
import { Stars } from './Stars';
import { YEARS_EXPERIENCE, labelFor } from '../lib/facilitator-intake';
import { shortName } from '../lib/names';

const deliveryLabel = (mode: Facilitator['delivery_mode']): string =>
  mode === 'both' ? 'Online or in person' : mode === 'in_person' ? 'In person' : 'Online';

const BULLET = /^[•·*\-–]\s+/;

/** Whether a value carries real markup, versus plain text a facilitator typed
 *  into a textarea. Shared so `parseOffer` and `Prose` agree on the answer. */
const HAS_MARKUP = /<[a-z][^>]*>/i;

/**
 * Free text stored with real newlines — a bio, a service description — that was
 * going straight into `dangerouslySetInnerHTML`, where HTML collapses every
 * newline. The public page rendered a run-on blob while the edit screen (a
 * plain `<textarea>`) showed the paragraph breaks the facilitator actually
 * typed. This is what closes that gap.
 *
 * A value with real markup came through the CMS rich-text allowlist and is
 * already structured — it renders as HTML, untouched. Plain text is split into
 * paragraphs on blank lines, with single newlines kept as line breaks inside a
 * paragraph via `pre-wrap`.
 */
function Prose({ text, className }: { text: string; className?: string }) {
  if (HAS_MARKUP.test(text)) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: text }} />;
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {p}
        </p>
      ))}
    </div>
  );
}

type ParsedOffer = { eyebrow: string | null; lede: string[]; points: string[] };

/**
 * Service descriptions are stored as plain text with real newlines —
 * facilitators type a label line, a sentence about who it is for, then a list
 * of bullet lines:
 *
 *     MINIMUM 3 MONTHS
 *     For those who want to understand themselves more deeply.
 *
 *     • One 60-minute 1:1 coaching session per month
 *     • Personal growth goal-setting
 *
 * That text was going straight into `dangerouslySetInnerHTML`, where HTML
 * collapses every newline — so a carefully structured offer rendered as one
 * run-on blob and every tier card became a wall of text. This recovers the
 * structure the facilitator already wrote.
 *
 * Returns null when there is nothing to recover — either the value contains
 * real markup (it came from the rich-text editor and is already structured) or
 * it has no bullet lines to lift out. Both fall back to rendering as HTML.
 */
function parseOffer(text: string): ParsedOffer | null {
  if (HAS_MARKUP.test(text)) return null;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const points: string[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    if (BULLET.test(line)) points.push(line.replace(BULLET, ''));
    else prose.push(line);
  }
  if (points.length === 0) return null;

  // A short all-caps opener is a label ("MINIMUM 3 MONTHS"), not a sentence,
  // so it becomes the card's eyebrow rather than its first paragraph.
  const opener = prose[0];
  const isLabel =
    opener !== undefined && opener.length <= 40 && /[A-Z]/.test(opener) && opener === opener.toUpperCase();

  return { eyebrow: isLabel ? prose.shift()! : null, lede: prose, points };
}

/** Hosts we can name properly, rather than showing a bare domain as the label. */
const PLATFORMS: [RegExp, string][] = [
  [/instagram\.com/i, 'Instagram'],
  [/facebook\.com|fb\.com/i, 'Facebook'],
  [/tiktok\.com/i, 'TikTok'],
  [/linkedin\.com/i, 'LinkedIn'],
  [/youtube\.com|youtu\.be/i, 'YouTube'],
  [/(^|\.)x\.com|twitter\.com/i, 'X'],
  [/threads\.net/i, 'Threads'],
];

/**
 * The links under the headline, deduped and named.
 *
 * The raw data is messier than the old one-line map assumed. Miss Kayce's row
 * carries `website_url` *and* a `social_links.website` holding the same URL,
 * plus a `social_links.social` of "https://misskayce/" — a host with no dot,
 * typed without the TLD. Rendered literally that produced
 * "Website · misskayce · website": three links, one a duplicate of another and
 * one that resolves nowhere.
 *
 * So: anything that is not a resolvable absolute URL is dropped rather than
 * shown as dead text (the apply form accepts a bare "@handle", which reads as
 * noise here and is already covered by the profile copy), duplicates collapse
 * on their normalized URL, and a known platform gets its own name instead of a
 * hostname. `website_url` goes first because it is the one link a client is
 * actually looking for.
 */
function profileLinks(f: Facilitator): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const seen = new Set<string>();

  const push = (value: unknown, preferred?: string) => {
    const raw = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    // "https://misskayce/" parses fine but names no reachable host. A hostname
    // with no dot is a typo, not a site.
    if (!url.hostname.includes('.')) return;

    const key = `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const platform = PLATFORMS.find(([pattern]) => pattern.test(url.hostname))?.[1];
    out.push({ label: platform ?? preferred ?? url.hostname.replace(/^www\./, ''), href: raw });
  };

  push(f.website_url, 'Website');
  for (const value of Object.values(f.social_links ?? {})) push(value);
  return out;
}

/**
 * A specialty split into the bit worth scanning and the bit that explains it.
 *
 * Facilitators write these as a label with the explanation appended —
 * "Personal Branding (Creating Your Personal Brand through visual language
 * that translates your personality and core values" — and the whole string was
 * going into a hero chip. A 120-character chip is not a chip: it rendered as a
 * full-width lozenge wrapping onto two lines, and three of them buried the
 * name they sat under.
 *
 * The label is what the chip shows; the explanation moves to "What I help
 * with" in the body, where there is room for it. An unbalanced "(" is closed
 * on the way past — that is a typo in the copy, not something a reader should
 * have to see.
 */
function splitSpecialty(text: string): { label: string; detail: string | null } {
  const match = text.match(/^(.+?)\s*[([]\s*(.+)$/);
  if (!match) {
    const dashed = text.match(/^(.{3,40}?)\s+[—–]\s+(.+)$/);
    return dashed
      ? { label: dashed[1].trim(), detail: dashed[2].trim() }
      : { label: text.trim(), detail: null };
  }
  const detail = match[2].replace(/[)\]]\s*$/, '').trim();
  return { label: match[1].trim(), detail: detail || null };
}

/** A booking link, or the same button rendered inert in the admin preview. */
function BookAction({
  className,
  to,
  preview,
  children,
}: {
  className: string;
  to: string;
  preview: boolean;
  children: ReactNode;
}) {
  if (preview) {
    return (
      <span className={className} aria-disabled="true" style={{ opacity: 0.6, cursor: 'default' }}>
        {children}
      </span>
    );
  }
  return (
    <Link className={className} to={to}>
      {children}
    </Link>
  );
}

export default function FacilitatorProfileView({
  facilitator,
  services,
  rating,
  reviews,
  rootRef,
  backLink = null,
  preview = false,
}: {
  facilitator: Facilitator;
  services: FacilitatorService[];
  rating: RatingSummary;
  reviews: PublicReview[];
  /** The page passes its flip-animation ref through; the editor does not. */
  rootRef?: RefObject<HTMLElement | null>;
  backLink?: ReactNode;
  preview?: boolean;
}) {
  const f = facilitator;
  const slug = f.slug;
  const freeCall = services.find((s) => s.kind === 'exploratory');
  // Cheapest first, so the tiers read as the ladder they are rather than in
  // whatever order they happened to be created in.
  const paid = services
    .filter((s) => s.kind !== 'exploratory')
    .sort((a, b) => a.price_centavos - b.price_centavos);
  const firstName = shortName(f.display_name, f.short_name);

  // The application form accepts a bare "@handle" as well as a URL, so a value
  // here is not necessarily linkable — an un-linkable one renders as plain text
  // rather than as a dead anchor.
  const links = profileLinks(f);

  const specialties = f.specialties.map(splitSpecialty);
  // Only worth its own section when the labels in the hero left something
  // unsaid. Where a facilitator wrote plain tags ("Emotional Wellbeing") the
  // chips already are the list, and repeating them below would be filler.
  const explained = specialties.filter((s) => s.detail);

  const glanceRows: { label: string; value: string }[] = [
    f.years_experience
      ? { label: 'Experience', value: labelFor(YEARS_EXPERIENCE, f.years_experience) }
      : null,
    { label: 'Sessions', value: deliveryLabel(f.delivery_mode) },
    f.languages.length > 0 ? { label: 'Languages', value: f.languages.join(', ') } : null,
    f.location ? { label: 'Based in', value: f.location } : null,
  ].filter((r): r is { label: string; value: string } => r !== null);

  return (
    <article className="section fac" ref={rootRef}>
      {backLink}

      {/* ---- header band ------------------------------------------------- */}
      <header className="fac-hero">
        <div className="container fac-hero__inner">
          {f.photo_url ? (
            <img
              src={f.photo_url}
              alt={f.display_name}
              className="fac-hero__photo"
              data-flip-id={`facilitator-photo-${slug}`}
            />
          ) : (
            <div
              className="fac-hero__photo fac-hero__monogram"
              data-flip-id={`facilitator-photo-${slug}`}
              aria-hidden="true"
            >
              {f.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}

          <div className="fac-hero__id">
            <h1 data-flip-id={`facilitator-title-${slug}`}>{f.display_name}</h1>
            {f.headline && <p className="fac-hero__headline">{f.headline}</p>}

            <p className="fac-hero__meta">
              {[
                deliveryLabel(f.delivery_mode),
                f.location,
                f.years_experience ? labelFor(YEARS_EXPERIENCE, f.years_experience) : null,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </p>

            {links.length > 0 && (
              <p className="fac-hero__links">
                {links.map(({ label, href }, i) => (
                  <span key={href}>
                    {i > 0 && <span aria-hidden="true"> · </span>}
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                      {label}
                    </a>
                  </span>
                ))}
              </p>
            )}

            {specialties.length > 0 && (
              <ul className="cv-chips fac-hero__tags">
                {specialties.map((s) => (
                  <li key={s.label} className="cv-chip">{s.label}</li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- the ask -------------------------------------------------
              A profile in a marketplace exists to be booked from, and until
              now the first way to do that was a thousand pixels below the
              fold, past the whole bio. The right-hand third of the header
              band was empty the entire time. This is the cheapest price, the
              free call if there is one, and one button — the same three facts
              the booking section opens with, said where people arrive. */}
          {(freeCall || paid.length > 0) && (
            <div className="fac-hero__act">
              {rating.average !== null && (
                <p className="fac-hero__rating">
                  <Stars value={rating.average} /> {rating.average.toFixed(1)}
                  <span className="muted"> · {rating.count} {rating.count === 1 ? 'review' : 'reviews'}</span>
                </p>
              )}

              {paid.length > 0 && (
                <p className="fac-hero__from">
                  <span>From</span>
                  <strong>{displayPrice(paid[0].price_centavos, paid[0].currency)}</strong>
                </p>
              )}

              {freeCall ? (
                <>
                  <BookAction
                    className="btn btn-accent btn-block"
                    to={`/book/${f.slug}/${freeCall.id}`}
                    preview={preview}
                  >
                    Book a free intro call
                  </BookAction>
                  <p className="fac-hero__act-note">
                    {formatDuration(freeCall.duration_minutes)}, no charge — start here if you're
                    not sure yet.
                  </p>
                </>
              ) : (
                <a className="btn btn-accent btn-block" href="#sessions">
                  See sessions
                </a>
              )}

              {freeCall && paid.length > 0 && (
                <a className="fac-hero__act-link" href="#sessions">
                  or see all {paid.length} {paid.length === 1 ? 'session' : 'sessions'} ↓
                </a>
              )}
            </div>
          )}
        </div>
      </header>

      {/* ---- who this is -------------------------------------------------
          The bio runs full width above a row of decision panels, rather than
          in a column beside them. As a sidebar they were far taller than a
          typical bio, which left several hundred pixels of dead space next to
          a seven-line paragraph. */}
      <div className="fac-body-band">
      <div className="container fac-body">
        <div className="fac-body__main">
          {f.bio && (
            <section className="fac-section">
              <h2>About {firstName}</h2>
              {/* Sanitized server-side on write with the allowlist the CMS
                  rich-text blocks use — see facilitator-input.ts. `Prose`
                  recovers the paragraph breaks when it was typed as plain
                  text, which is what the textarea on the edit screen keeps. */}
              <Prose className="fac-prose" text={f.bio} />
            </section>
          )}

          {/* Where the explanations from the hero chips land. See
              `splitSpecialty`: the chip carries the name of the thing, this
              carries what it actually involves — which is the part a client
              weighing two facilitators is reading for. */}
          {explained.length > 0 && (
            <section className="fac-section">
              <h2>What {firstName} helps with</h2>
              <dl className="fac-helps">
                {explained.map((s) => (
                  <div key={s.label}>
                    <dt>{s.label}</dt>
                    <dd>{s.detail}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* The section the whole feature exists for. A wellness marketplace
              with no visible social proof asks a client to book a stranger for
              an intimate 1:1 on the strength of a self-written bio. */}
          {reviews.length > 0 && (
            <section className="fac-section">
              <h2>
                What people say
                {rating.average !== null && (
                  <span className="small muted" style={{ marginLeft: '0.6rem', fontWeight: 400 }}>
                    <Stars value={rating.average} /> {rating.average.toFixed(1)} from {rating.count}{' '}
                    {rating.count === 1 ? 'review' : 'reviews'}
                  </span>
                )}
              </h2>

              {reviews.map((r) => (
                <div key={r.id} className="card" style={{ marginBottom: '0.6rem' }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Stars value={r.rating} />
                    <span className="small muted">
                      {new Intl.DateTimeFormat('en-PH', {
                        dateStyle: 'medium',
                      }).format(new Date(r.created_at))}
                    </span>
                  </div>
                  {r.comment && (
                    <p className="small" style={{ margin: '0.4rem 0 0', whiteSpace: 'pre-wrap' }}>
                      {r.comment}
                    </p>
                  )}
                  <p className="small muted" style={{ margin: '0.35rem 0 0' }}>
                    — {r.client_label ?? 'A client'}
                  </p>
                </div>
              ))}

              <p className="small muted">
                Reviews come from people who booked and attended a session here, and are read
                before they appear.
              </p>
            </section>
          )}
        </div>

        {/* ---- sidebar ------------------------------------------------- */}
        <aside className="fac-body__aside">
          {glanceRows.length > 0 && (
            <div className="panel fac-panel">
              <h3>At a glance</h3>
              <dl className="fac-glance">
                {glanceRows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {f.credentials.length > 0 && (
            <div className="panel fac-panel">
              <h3>Credentials</h3>
              <ul className="fac-creds">
                {f.credentials.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

        </aside>
      </div>

      {/* Shown verbatim and deliberately not buried: a coach, a breathwork
          facilitator and a licensed psychologist are not interchangeable, and
          a client is entitled to know which they are booking.

          Its own full-width band rather than a third card in the sidebar. It
          is several paragraphs of the most consequential text on the page, and
          in a 16rem column it rendered as a 440px wall of 0.9rem type that
          nobody was going to read — the opposite of not burying it. `Prose`
          also restores the paragraph breaks the facilitator typed, which a
          bare text node dropped the same way the bio's did. */}
      {f.scope_note && (
        <section className="fac-scope">
          <div className="container fac-scope__inner">
            <h3>Scope of practice</h3>
            <Prose className="fac-scope__body" text={f.scope_note} />
          </div>
        </section>
      )}
      </div>

      {/* ---- booking ----------------------------------------------------
          Its own full-bleed band rather than a block inside the main column.
          A facilitator can list four or five tiers, and squeezed beside the
          300px sidebar each one got about 240px — too narrow to compare, which
          is the only thing this section is for. */}
      {(freeCall || paid.length > 0) && (
        <section className="cv-band cv-band--sand fac-booking" id="sessions">
          <div className="container">
            <div className="cv-head cv-head--center" style={{ marginBottom: '2.25rem' }}>
              <h2>Book a session with {firstName}</h2>
              {paid.length > 1 && (
                <p>Start with a single session or commit to a longer arc — the choice is yours.</p>
              )}
            </div>

            {/* The free call is a different kind of thing from the tiers, so it
                gets a full-width banner above them rather than competing as the
                cheapest column in a price ladder. */}
            {freeCall && (
              <div className="fac-intro">
                <div>
                  <span className="cv-chip">Complimentary</span>
                  <h3>{freeCall.title}</h3>
                  {/* The facilitator's own description of their intro call
                      when they wrote one — "Let's get to know each other!",
                      "Discover which session/s suit their needs most" — which
                      the generic sentence below was overwriting. The fallback
                      stays for the facilitators who left the field empty. */}
                  <p>
                    {freeCall.description?.trim() || (
                      <>
                        A short conversation to understand what you're looking for and see whether{' '}
                        {firstName} is the right fit.
                      </>
                    )}{' '}
                    <span className="muted">
                      {formatDuration(freeCall.duration_minutes)}, one per person.
                    </span>
                  </p>
                </div>
                <BookAction className="btn btn-accent" to={`/book/${f.slug}/${freeCall.id}`} preview={preview}>
                  Book an intro call
                </BookAction>
              </div>
            )}

            {paid.length === 0 && !freeCall && (
              <p className="muted cv-center">
                This facilitator hasn't opened any sessions for booking yet.
              </p>
            )}

            <div className="fac-tiers">
              {paid.map((s) => {
                const isPackage = s.kind === 'package' && s.sessions_count > 1;
                const offer = s.description ? parseOffer(s.description) : null;
                return (
                  <article key={s.id} className="fac-tier">
                    {offer?.eyebrow && <p className="cv-eyebrow">{offer.eyebrow}</p>}
                    <h3 className="fac-tier__name">{s.title}</h3>
                    <p className="fac-tier__meta">
                      {isPackage
                        ? `${s.sessions_count} sessions · ${formatDuration(s.duration_minutes)} each`
                        : formatDuration(s.duration_minutes)}
                    </p>

                    {offer ? (
                      <>
                        {offer.lede.map((line, i) => (
                          <p className="fac-tier__lede" key={i}>
                            {line}
                          </p>
                        ))}
                        <ul className="cv-checks fac-tier__points">
                          {offer.points.map((point, i) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      s.description && <Prose className="fac-prose small" text={s.description} />
                    )}

                    {/* Everything below is pinned to the bottom of the card, so
                        price and button line up across tiers of unequal length
                        instead of stepping down the row. */}
                    <div className="fac-tier__foot">
                      {/* Both branches emit the second line, so the price rows
                          sit on one baseline across the ladder — a single
                          session has no per-session figure to show, but it
                          still needs the space the packages take. */}
                      <p className="fac-tier__price">
                        {displayPrice(s.price_centavos, s.currency)}
                        <span className="fac-tier__unit">
                          {isPackage
                            ? `${displayPrice(Math.round(s.price_centavos / s.sessions_count), s.currency)} a session`
                            : 'a single session'}
                        </span>
                      </p>

                      {/* A package is bought once and scheduled afterwards, so
                          "Choose a time" would be a lie — there are N times to
                          choose, and none of them are chosen here (0035). */}
                      <BookAction className="btn btn-primary btn-block" to={`/book/${f.slug}/${s.id}`} preview={preview}>
                        {isPackage ? `Buy ${s.sessions_count} sessions` : 'Choose a time'}
                      </BookAction>

                      {/* Folded away by default. Four tiers each showing three
                          lines of refund terms put more visual weight on the
                          cancellation rules than on the price. */}
                      <details className="fac-tier__terms">
                        <summary>Booking &amp; refund terms</summary>
                        {isPackage && <p>You book each session as you go, whenever suits you.</p>}
                        <p>{describeRefundPolicy(s)}</p>
                        {s.cancellation_policy && <p>{s.cancellation_policy}</p>}
                      </details>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </article>
  );
}

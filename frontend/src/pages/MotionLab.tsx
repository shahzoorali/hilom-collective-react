import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { SplitText } from 'gsap/SplitText';

gsap.registerPlugin(Flip, SplitText);

/**
 * Motion Lab — a comparison page for the six candidate GSAP page transitions.
 *
 * Every demo runs inside a bounded <Stage> rather than hijacking the real
 * viewport, so the six can be judged side by side and a misbehaving timeline
 * can't strand the page. The tweens here are the *actual* tweens intended for
 * production; once one is chosen, the timeline moves into a route-transition
 * wrapper around <main> in Layout.tsx essentially unchanged.
 *
 * This route is a design tool, not part of the marketing site: it's absent
 * from the nav and from the prerender/sitemap route list.
 */

/* --------------------------------------------------------------------------
   Shared scaffolding
   -------------------------------------------------------------------------- */

/** A fake Hilom page, used as the "before" and "after" of each transition. */
function FakePage({
  eyebrow,
  title,
  body,
  tone = 'cream',
  children,
}: {
  eyebrow: string;
  title: string;
  body: string;
  tone?: 'cream' | 'white';
  children?: React.ReactNode;
}) {
  return (
    <div className={`ml-page ml-page--${tone}`}>
      <div className="ml-fakehead">
        <span className="ml-fakelogo">HILOM</span>
        <span className="ml-fakenav">
          <i /> <i /> <i />
        </span>
      </div>
      <div className="ml-pagebody">
        <p className="ml-eyebrow">{eyebrow}</p>
        <h3 className="ml-title">{title}</h3>
        <p className="ml-body">{body}</p>
        {children}
      </div>
    </div>
  );
}

/** The bounded viewport each demo animates inside. */
function Stage({
  stageRef,
  children,
}: {
  stageRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <div className="ml-stage" ref={stageRef}>
      {children}
    </div>
  );
}

function Demo({
  n,
  name,
  tagline,
  why,
  where,
  duration,
  cost,
  onReplay,
  replayLabel = 'Replay',
  children,
  snippet,
}: {
  n: number;
  name: string;
  tagline: string;
  why: string;
  where: string;
  duration: string;
  cost: string;
  onReplay: () => void;
  replayLabel?: string;
  children: React.ReactNode;
  snippet: string;
}) {
  const [showCode, setShowCode] = useState(false);
  return (
    <section className="ml-demo" id={`demo-${n}`}>
      <div className="ml-demo-head">
        <span className="ml-num">{n}</span>
        <div>
          <h2 className="ml-name">{name}</h2>
          <p className="ml-tagline">{tagline}</p>
        </div>
      </div>

      {children}

      <div className="ml-controls">
        <button className="btn btn-accent" onClick={onReplay}>
          {replayLabel}
        </button>
        <button className="btn btn-ghost" onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide code' : 'Show code'}
        </button>
      </div>

      {showCode && <pre className="ml-code">{snippet}</pre>}

      <dl className="ml-meta">
        <div>
          <dt>Why it fits</dt>
          <dd>{why}</dd>
        </div>
        <div>
          <dt>Where it applies</dt>
          <dd>{where}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>Added weight</dt>
          <dd>{cost}</dd>
        </div>
      </dl>
    </section>
  );
}

/* --------------------------------------------------------------------------
   1 — Ginhawa: the exhale fade
   -------------------------------------------------------------------------- */

const GINHAWA_CODE = `const tl = gsap.timeline();
tl.to(outgoing, { opacity: 0, y: -8, scale: 0.995,
                  duration: 0.3, ease: 'power2.in' })
  .set(outgoing, { display: 'none' })
  .call(commitRoute)                       // swap route + reset scroll here
  .fromTo(incoming, { opacity: 0, y: 14 },
          { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' })
  .fromTo(incoming.children, { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.45,
            stagger: 0.06, ease: 'power2.out' }, '<0.1');`;

function GinhawaDemo() {
  const root = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);

  const play = () => {
    const ctx = gsap.context(() => {
      const outgoing = root.current!.querySelector('.ml-a')!;
      const incoming = root.current!.querySelector('.ml-b')!;
      const kids = incoming.querySelectorAll('.ml-pagebody > *');

      tl.current?.kill();
      gsap.set(outgoing, { opacity: 1, y: 0, scale: 1, zIndex: 2 });
      gsap.set(incoming, { opacity: 0, zIndex: 1 });

      tl.current = gsap
        .timeline()
        .to(outgoing, { opacity: 0, y: -8, scale: 0.995, duration: 0.3, ease: 'power2.in' })
        .set(outgoing, { zIndex: 0 })
        .set(incoming, { zIndex: 2 })
        .fromTo(incoming, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' })
        .fromTo(
          kids,
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.45, stagger: 0.06, ease: 'power2.out' },
          '<0.1'
        )
        // Reset so the demo can be replayed from the same starting frame.
        .to({}, { duration: 0.9 })
        .to(incoming, { opacity: 0, duration: 0.25 })
        .set(outgoing, { opacity: 1, y: 0, scale: 1, zIndex: 2 });
    }, root);
    return () => ctx.revert();
  };

  useEffect(() => {
    const cleanup = play();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Demo
      n={1}
      name="Ginhawa — the exhale fade"
      tagline="Asymmetric crossfade: quick out-breath, slow settle, children arriving in reading order."
      why="Out is shorter than in, which is the cadence of an actual sigh. Nothing slides; opacity does the work."
      where="Global default for every marketing route."
      duration="~800ms total"
      cost="GSAP core only, ~23KB gz"
      onReplay={play}
      snippet={GINHAWA_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer ml-a">
          <FakePage
            eyebrow="Home"
            title="Healing, rooted in kapwa"
            body="A living space for Filipino-centered healing — courses, circles, and facilitators."
          />
        </div>
        <div className="ml-layer ml-b">
          <FakePage
            tone="white"
            eyebrow="About"
            title="A pamana we are still writing"
            body="Hilom Collective began as a question about what rest looks like when it is ours."
          >
            <div className="ml-chiprow">
              <span className="ml-chip">Ginhawa Kits</span>
              <span className="ml-chip">Hilom Journals</span>
              <span className="ml-chip">Pahinga Retreats</span>
            </div>
          </FakePage>
        </div>
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   2 — Pahinga: the cream veil with a hill curve
   -------------------------------------------------------------------------- */

const PAHINGA_CODE = `gsap.timeline()
  .fromTo(veil,
    { yPercent: 100, borderTopLeftRadius: '50% 12vh',
                     borderTopRightRadius: '50% 12vh' },
    { yPercent: 0,   borderTopLeftRadius: '0%',
                     borderTopRightRadius: '0%',
      duration: 0.5, ease: 'power3.inOut' })
  .call(commitRoute)          // swap route + scrollTo(0) while covered
  .to(veil, { yPercent: -100, duration: 0.55, ease: 'power3.inOut' });`;

function PahingaDemo() {
  const root = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);

  const play = () => {
    const el = root.current!;
    const veil = el.querySelector('.ml-veil')!;
    const a = el.querySelector('.ml-a')!;
    const b = el.querySelector('.ml-b')!;

    tl.current?.kill();
    gsap.set(a, { opacity: 1, zIndex: 1 });
    gsap.set(b, { opacity: 0, zIndex: 1 });

    tl.current = gsap
      .timeline()
      .fromTo(
        veil,
        { yPercent: 100, borderTopLeftRadius: '50% 46px', borderTopRightRadius: '50% 46px' },
        {
          yPercent: 0,
          borderTopLeftRadius: '0% 0px',
          borderTopRightRadius: '0% 0px',
          duration: 0.5,
          ease: 'power3.inOut',
        }
      )
      // The route swap and the scroll reset happen here, fully covered — which
      // is the practical reason to prefer this one: the scroll jump is hidden.
      .set(a, { opacity: 0 })
      .set(b, { opacity: 1 })
      .to(veil, { yPercent: -100, duration: 0.55, ease: 'power3.inOut' })
      .to({}, { duration: 0.9 })
      .set(veil, { yPercent: 100 })
      .set(a, { opacity: 1 })
      .set(b, { opacity: 0 });
  };

  useEffect(() => {
    play();
    return () => {
      tl.current?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Demo
      n={2}
      name="Pahinga — the cream veil"
      tagline="A cream panel passes through the frame, its top edge a soft hill that flattens as it covers."
      why="A pass-through, never a cover-and-retreat, so the page is never 'hidden' from you. The curved edge echoes the brand's organic shapes instead of a hard rectangle."
      where="Top-level nav jumps: /about, /services, /community, /events."
      duration="~1050ms total"
      cost="GSAP core only, ~23KB gz"
      onReplay={play}
      snippet={PAHINGA_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer ml-a">
          <FakePage
            eyebrow="Services"
            title="Ways to be held"
            body="One-to-one sessions, group circles, and workplace programs led by our facilitators."
          />
        </div>
        <div className="ml-layer ml-b">
          <FakePage
            tone="white"
            eyebrow="Community"
            title="You are not doing this alone"
            body="Monthly gatherings, online and in Metro Manila, open to anyone who needs a room."
          />
        </div>
        <div className="ml-veil" />
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   3 — Pamana: shared-element card → hero (GSAP Flip)
   -------------------------------------------------------------------------- */

const PAMANA_CODE = `// on the catalog, before navigating:
const state = Flip.getState('[data-flip-id]');
navigate(\`/courses/\${slug}\`);   // detail hero carries matching data-flip-id

// in the detail page's useLayoutEffect:
Flip.from(state, {
  duration: 0.6, ease: 'expo.out',
  absolute: true, scale: true,
  fade: true,
});`;

const COURSES = [
  { slug: 'understand-yourself', name: 'Module 1: Understand Yourself', price: '₱1,500', hue: 'a' },
  { slug: 'build-resilience', name: 'Module 2: Build Resilience', price: '₱1,500', hue: 'b' },
  { slug: 'breakthrough-bundle', name: 'The Breakthrough Bundle', price: '₱3,900', hue: 'c' },
] as const;

function PamanaDemo() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);
  const flipState = useRef<Flip.FlipState | null>(null);

  const go = (index: number | null) => {
    // Capture geometry BEFORE React re-renders the other view.
    flipState.current = Flip.getState(root.current!.querySelectorAll('[data-flip-id]'), {
      props: 'borderRadius,fontSize',
    });
    setOpen(index);
  };

  useLayoutEffect(() => {
    if (!flipState.current) return;
    Flip.from(flipState.current, {
      duration: 0.6,
      ease: 'expo.out',
      absolute: true,
      scale: true,
      fade: true,
      props: 'borderRadius,fontSize',
    });
    flipState.current = null;
  }, [open]);

  return (
    <Demo
      n={3}
      name="Pamana — card becomes hero"
      tagline="The course card's art and title are not replaced by the detail hero; they travel into it."
      why="Continuity of the product across the click removes the 'did I land on the right thing?' beat immediately before a peso decision. Highest commercial value of the six."
      where="/courses → /courses/:slug, and /facilitators → /facilitators/:slug."
      duration="600ms"
      cost="core + Flip, ~31KB gz (lazy-load Flip on catalog routes only)"
      onReplay={() => go(open === null ? 2 : null)}
      replayLabel={open === null ? 'Open a course' : 'Back to catalog'}
      snippet={PAMANA_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer" style={{ zIndex: 2 }}>
          <div className="ml-page ml-page--white">
            <div className="ml-fakehead">
              <span className="ml-fakelogo">HILOM</span>
              <span className="ml-fakenav">
                <i /> <i /> <i />
              </span>
            </div>

            {open === null ? (
              <div className="ml-pagebody">
                <p className="ml-eyebrow">Courses</p>
                <div className="ml-cardgrid">
                  {COURSES.map((c, i) => (
                    <button key={c.slug} className="ml-card" onClick={() => go(i)}>
                      <span
                        className={`ml-cardmedia ml-hue-${c.hue}`}
                        data-flip-id={`media-${c.slug}`}
                      />
                      <span className="ml-cardtitle" data-flip-id={`title-${c.slug}`}>
                        {c.name}
                      </span>
                      <span className="ml-cardprice">{c.price}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="ml-pagebody">
                <button className="ml-back" onClick={() => go(null)}>
                  ← All courses
                </button>
                <span
                  className={`ml-herohue ml-hue-${COURSES[open].hue}`}
                  data-flip-id={`media-${COURSES[open].slug}`}
                />
                <span className="ml-herotitle" data-flip-id={`title-${COURSES[open].slug}`}>
                  {COURSES[open].name}
                </span>
                <p className="ml-body">
                  Six lessons, permanent access, and a workbook you keep. {COURSES[open].price}
                </p>
              </div>
            )}
          </div>
        </div>
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   4 — Hilom: the headline settle (SplitText)
   -------------------------------------------------------------------------- */

const HILOM_CODE = `const split = SplitText.create(h1, { type: 'lines,words', mask: 'lines' });
gsap.timeline()
  .from(split.words, { yPercent: 110, duration: 0.6,
                       stagger: 0.04, ease: 'expo.out' })
  .from(rule, { scaleX: 0, transformOrigin: 'left',
                duration: 0.5, ease: 'power2.out' }, '-=0.25');
// split.revert() on unmount`;

function HilomDemo() {
  const root = useRef<HTMLDivElement>(null);

  const play = () => {
    const h = root.current!.querySelector('.ml-splittitle') as HTMLElement;
    const rule = root.current!.querySelector('.ml-rule')!;
    const lede = root.current!.querySelector('.ml-splitlede')!;

    const split = SplitText.create(h, { type: 'lines,words', mask: 'lines' });
    gsap
      .timeline({
        // SplitText wraps the heading in extra DOM; always revert so React and
        // screen readers get the original element back.
        onComplete: () => split.revert(),
      })
      .from(split.words, { yPercent: 110, duration: 0.6, stagger: 0.04, ease: 'expo.out' })
      .from(rule, { scaleX: 0, transformOrigin: 'left', duration: 0.5, ease: 'power2.out' }, '-=0.25')
      .from(lede, { opacity: 0, y: 10, duration: 0.5, ease: 'power2.out' }, '-=0.35');
  };

  useEffect(() => {
    play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Demo
      n={4}
      name="Hilom — the headline settle"
      tagline="Libre Baskerville words rise out of a clipped line, then the ochre rule draws beneath."
      why="Serif is the one typeface worth animating slowly, and masking beats a plain fade — the words arrive from somewhere rather than materialising."
      where="The h1 of every marketing page. Pairs with #1 as the incoming half."
      duration="~850ms"
      cost="core + SplitText, ~28KB gz"
      onReplay={play}
      snippet={HILOM_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer" style={{ zIndex: 2 }}>
          <div className="ml-page ml-page--cream">
            <div className="ml-fakehead">
              <span className="ml-fakelogo">HILOM</span>
              <span className="ml-fakenav">
                <i /> <i /> <i />
              </span>
            </div>
            <div className="ml-pagebody">
              <p className="ml-eyebrow">About</p>
              <h3 className="ml-splittitle">A living space for healing</h3>
              <span className="ml-rule" />
              <p className="ml-body ml-splitlede">
                Rooted in kapwa, carried by the people who show up for each other.
              </p>
            </div>
          </div>
        </div>
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   5 — Ochre bloom from the click point
   -------------------------------------------------------------------------- */

const BLOOM_CODE = `function onCtaClick(e) {
  const r = stage.getBoundingClientRect();
  gsap.set(bloom, { left: e.clientX - r.left, top: e.clientY - r.top });
  gsap.timeline()
    .fromTo(bloom, { scale: 0, opacity: 0.55 },
            { scale: 14, opacity: 0, duration: 0.7, ease: 'power2.out' })
    .add(ginhawaTimeline(), 0.12);   // layers over the default transition
}`;

function BloomDemo() {
  const root = useRef<HTMLDivElement>(null);

  const fire = (e: React.MouseEvent) => {
    const stage = root.current!;
    const bloom = stage.querySelector('.ml-bloom')!;
    const a = stage.querySelector('.ml-a')!;
    const b = stage.querySelector('.ml-b')!;
    const r = stage.getBoundingClientRect();

    gsap.set(bloom, { left: e.clientX - r.left, top: e.clientY - r.top });
    gsap
      .timeline()
      .fromTo(bloom, { scale: 0, opacity: 0.55 }, { scale: 14, opacity: 0, duration: 0.7, ease: 'power2.out' })
      .to(a, { opacity: 0, duration: 0.3, ease: 'power2.in' }, 0.12)
      .fromTo(b, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, '<0.15')
      .to({}, { duration: 1 })
      .to(b, { opacity: 0, duration: 0.25 })
      .set(a, { opacity: 1 });
  };

  return (
    <Demo
      n={5}
      name="Ochre bloom from the click"
      tagline="A soft ochre radial expands from the exact cursor point, only on decision clicks."
      why="It gives the site two motion registers: browsing versus deciding. Ochre is already the brand's dedicated CTA colour, so the bloom reads as the button's own echo."
      where="CTA-initiated navigation only — Enroll, Book a session, Register."
      duration="~700ms, layered over #1"
      cost="GSAP core only, ~23KB gz"
      onReplay={() => {
        // Synthesise a click at the button's centre so the bloom still
        // originates from the CTA rather than from the stage's origin.
        const btn = root.current!.querySelector('.ml-cta') as HTMLElement;
        const b = btn.getBoundingClientRect();
        btn.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            clientX: b.left + b.width / 2,
            clientY: b.top + b.height / 2,
          })
        );
      }}
      replayLabel="Replay (or click the button in the frame)"
      snippet={BLOOM_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer ml-a">
          <FakePage
            eyebrow="Course"
            title="The Breakthrough Bundle"
            body="Three modules, permanent access, one price."
          >
            <button className="btn btn-accent ml-cta" onClick={fire}>
              Enroll — ₱3,900
            </button>
          </FakePage>
        </div>
        {/* pointer-events:none matters — the layer sits above ml-a in the
            stacking order, so at opacity 0 it would still swallow the click
            on the Enroll button underneath it. */}
        <div className="ml-layer ml-b" style={{ opacity: 0, pointerEvents: 'none' }}>
          <FakePage
            tone="white"
            eyebrow="Checkout"
            title="Almost there"
            body="Confirm your details and choose how you'd like to pay."
          />
        </div>
        <span className="ml-bloom" />
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   6 — The breathing wait
   -------------------------------------------------------------------------- */

const BREATH_CODE = `gsap.timeline({ repeat: -1 })
  .to(circle, { scale: 1.25, opacity: 0.9, duration: 4, ease: 'sine.inOut' })
  .to(circle, { scale: 1,    opacity: 0.5, duration: 6, ease: 'sine.inOut' });
// label crossfades on the same beats: "Breathe in" / "Breathe out"`;

function BreathDemo() {
  const root = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);

  const play = () => {
    const circle = root.current!.querySelector('.ml-breath')!;
    const inLbl = root.current!.querySelector('.ml-breath-in')!;
    const outLbl = root.current!.querySelector('.ml-breath-out')!;

    tl.current?.kill();
    tl.current = gsap
      .timeline({ repeat: -1 })
      .to(circle, { scale: 1.25, opacity: 0.9, duration: 4, ease: 'sine.inOut' }, 0)
      .to(circle, { scale: 1, opacity: 0.5, duration: 6, ease: 'sine.inOut' }, 4)
      .set(inLbl, { opacity: 1 }, 0)
      .set(outLbl, { opacity: 0 }, 0)
      .set(inLbl, { opacity: 0 }, 4)
      .set(outLbl, { opacity: 1 }, 4);
  };

  useEffect(() => {
    play();
    return () => {
      tl.current?.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Demo
      n={6}
      name="The breathing wait"
      tagline="A 4s-in / 6s-out box-breath loop replacing the spinner while the order poll runs."
      why="The only animation here that does real work: it turns unavoidable dead time after payment into the product itself. Safe on a money path because it doesn't gate anything."
      where="Processing.tsx, BookingProcessing.tsx, RegistrationProcessing.tsx."
      duration="10s loop, runs until the poll resolves"
      cost="GSAP core only, ~23KB gz"
      onReplay={play}
      replayLabel="Restart loop"
      snippet={BREATH_CODE}
    >
      <Stage stageRef={root}>
        <div className="ml-layer" style={{ zIndex: 2 }}>
          <div className="ml-page ml-page--cream ml-center">
            <span className="ml-breath" />
            <span className="ml-breath-labels">
              <em className="ml-breath-in">Breathe in</em>
              <em className="ml-breath-out">Breathe out</em>
            </span>
            <p className="ml-body" style={{ marginTop: '1.2rem' }}>
              Confirming your payment. This usually takes a few seconds.
            </p>
          </div>
        </div>
      </Stage>
    </Demo>
  );
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */

export default function MotionLab() {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <>
      <style>{LAB_CSS}</style>

      <div className="hero">
        <div className="container">
          <p className="ml-eyebrow">Internal — design tool</p>
          <h1>Motion Lab</h1>
          <p className="lede">
            Six candidate GSAP page transitions, each running inside a bounded frame so they can
            be judged against one another. These are the production tweens, not mockups — the one
            you pick moves into a route wrapper around <code>&lt;main&gt;</code> in{' '}
            <code>Layout.tsx</code> essentially as written.
          </p>
          {reduced && (
            <p className="ml-warn">
              Your system is set to <strong>reduce motion</strong>. In production every timeline
              below collapses to a 120ms crossfade under that setting — but this page plays them
              in full so they can actually be reviewed.
            </p>
          )}
        </div>
      </div>

      <div className="container ml-wrap">
        <nav className="ml-jump">
          <span>Jump to:</span>
          {[
            'Ginhawa',
            'Pahinga',
            'Pamana',
            'Hilom',
            'Ochre bloom',
            'Breathing wait',
          ].map((label, i) => (
            <a key={label} href={`#demo-${i + 1}`}>
              {i + 1}. {label}
            </a>
          ))}
        </nav>

        <GinhawaDemo />
        <PahingaDemo />
        <PamanaDemo />
        <HilomDemo />
        <BloomDemo />
        <BreathDemo />

        <section className="panel ml-closing">
          <h2>If you ship three</h2>
          <p>
            <strong>1 (Ginhawa)</strong> globally, <strong>3 (Pamana)</strong> on the two
            catalog&rarr;detail paths, and <strong>6 (breathing wait)</strong> on the processing
            pages. That is the whole perceived-quality gain for roughly 31KB gzipped, with no motion
            added to checkout itself.
          </p>
          <p className="small">
            Whichever you choose, three things move with it: the scroll reset in{' '}
            <code>ScrollToTop.tsx</code> has to happen inside the timeline rather than on{' '}
            <code>pathname</code> change, start states must be set from JS so the prerendered HTML
            never ships at <code>opacity: 0</code>, and <code>/checkout</code>, <code>/admin/*</code>,{' '}
            <code>/facilitator/*</code> and the processing routes opt out of route transitions
            entirely.
          </p>
        </section>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------
   Styles — scoped with the ml- prefix, kept local to this design tool so
   nothing here can leak into the real site's stylesheet.
   -------------------------------------------------------------------------- */

const LAB_CSS = `
.ml-wrap { padding: 2.5rem 0 4rem; }
.ml-eyebrow { font-size: .72rem; letter-spacing: .14em; text-transform: uppercase;
  color: var(--muted); font-weight: 600; margin: 0 0 .5rem; }
.ml-warn { background: #fff6e2; border: 1px solid #f0d9a4; border-radius: var(--radius);
  padding: .75rem 1rem; font-size: .9rem; max-width: 46rem; }

.ml-jump { display: flex; flex-wrap: wrap; gap: .9rem; align-items: center;
  font-size: .85rem; padding: .9rem 1.1rem; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 2.5rem; }
.ml-jump span { color: var(--muted); font-weight: 600; }
.ml-jump a { color: var(--forest); text-decoration: none; font-weight: 500; }
.ml-jump a:hover { text-decoration: underline; }

.ml-demo { margin-bottom: 3.5rem; scroll-margin-top: 5rem; }
.ml-demo-head { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 1rem; }
.ml-num { flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 50%;
  background: var(--forest); color: #fff; font-family: var(--serif); font-weight: 700;
  display: grid; place-items: center; font-size: .95rem; }
.ml-name { font-size: 1.35rem; margin: 0 0 .2rem; }
.ml-tagline { margin: 0; color: var(--muted); font-size: .95rem; max-width: 52rem; }

/* The bounded viewport. overflow:hidden is what keeps a runaway tween from
   escaping into the real page. */
.ml-stage { position: relative; height: 340px; border: 1px solid var(--line);
  border-radius: 14px; overflow: hidden; background: var(--page);
  box-shadow: var(--shadow); }
.ml-layer { position: absolute; inset: 0; }
.ml-page { position: absolute; inset: 0; display: flex; flex-direction: column; }
.ml-page--cream { background: linear-gradient(160deg, var(--cream), #fff 72%); }
.ml-page--white { background: var(--surface); }
.ml-center { align-items: center; justify-content: center; text-align: center; }

.ml-fakehead { display: flex; align-items: center; gap: 1rem; padding: .7rem 1.2rem;
  border-bottom: 1px solid var(--line); background: rgba(255,255,255,.75); }
.ml-fakelogo { font-family: var(--serif); font-weight: 700; color: var(--forest);
  letter-spacing: .18em; font-size: .78rem; }
.ml-fakenav { margin-left: auto; display: flex; gap: .5rem; }
.ml-fakenav i { display: block; width: 26px; height: 6px; border-radius: 3px;
  background: var(--line); }

.ml-pagebody { padding: 1.4rem 1.6rem; }
.ml-title, .ml-splittitle, .ml-herotitle { font-family: var(--serif); font-weight: 700;
  color: var(--forest); font-size: 1.45rem; line-height: 1.25; margin: 0 0 .5rem;
  display: block; }
.ml-body { font-size: .9rem; color: #46523f; margin: 0; max-width: 34rem; }
.ml-rule { display: block; height: 3px; width: 84px; background: var(--ochre);
  border-radius: 2px; margin: .1rem 0 .9rem; }

.ml-chiprow { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
.ml-chip { font-size: .75rem; padding: .3rem .7rem; border-radius: 999px;
  background: var(--cream); color: var(--forest); font-weight: 600; }

/* 2 — veil */
.ml-veil { position: absolute; inset: 0; background: var(--cream); z-index: 5;
  transform: translateY(100%); will-change: transform; }

/* 3 — Flip */
.ml-cardgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .8rem; }
.ml-card { display: flex; flex-direction: column; gap: .45rem; text-align: left;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: .55rem; cursor: pointer; font: inherit; }
.ml-card:hover { border-color: var(--leaf); }
.ml-cardmedia { display: block; height: 62px; border-radius: 7px; }
.ml-cardtitle { display: block; font-family: var(--serif); font-weight: 700;
  color: var(--forest); font-size: .82rem; line-height: 1.25; }
.ml-cardprice { font-size: .78rem; color: var(--ochre-dark); font-weight: 700; }
.ml-herohue { display: block; height: 110px; border-radius: 12px; margin-bottom: .7rem; }
.ml-hue-a { background: linear-gradient(135deg, var(--leaf), var(--forest)); }
.ml-hue-b { background: linear-gradient(135deg, var(--ochre), var(--ochre-dark)); }
.ml-hue-c { background: linear-gradient(135deg, var(--forest), #1c3a26); }
.ml-back { background: none; border: 0; padding: 0 0 .6rem; font: inherit;
  font-size: .8rem; color: var(--muted); cursor: pointer; }

/* 5 — bloom */
.ml-bloom { position: absolute; width: 40px; height: 40px; margin: -20px 0 0 -20px;
  border-radius: 50%; background: var(--ochre); opacity: 0; pointer-events: none;
  z-index: 6; }
.ml-cta { margin-top: 1.1rem; }

/* 6 — breath */
.ml-breath { display: block; width: 92px; height: 92px; border-radius: 50%;
  background: radial-gradient(circle at 35% 32%, #a8c793, var(--leaf) 62%, var(--forest));
  opacity: .5; }
/* Fixed width: the labels are absolutely stacked, so without it the span
   shrink-wraps to the shorter one and "Breathe out" wraps onto the body copy. */
.ml-breath-labels { position: relative; display: block; width: 12rem; height: 1.2rem;
  margin-top: 1.6rem; }
.ml-breath-labels em { position: absolute; inset: 0; font-style: normal; white-space: nowrap;
  font-size: .8rem; letter-spacing: .1em; text-transform: uppercase;
  color: var(--muted); font-weight: 600; }
.ml-breath-out { opacity: 0; }

.ml-controls { display: flex; gap: .6rem; flex-wrap: wrap; margin: 1rem 0 0; }
.ml-code { background: #22301f; color: #dbe7d3; padding: 1rem 1.1rem; border-radius: 10px;
  font-size: .78rem; line-height: 1.55; overflow-x: auto; margin: 1rem 0 0; }

.ml-meta { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 1rem;
  margin: 1.2rem 0 0; padding-top: 1rem; border-top: 1px solid var(--line); }
.ml-meta dt { font-size: .68rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); font-weight: 700; margin-bottom: .3rem; }
.ml-meta dd { margin: 0; font-size: .85rem; color: #46523f; }

.ml-closing { padding: 1.6rem; }
.ml-closing h2 { margin-top: 0; }
code { background: var(--cream); padding: .1rem .35rem; border-radius: 4px; font-size: .88em; }

@media (max-width: 760px) {
  .ml-meta { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .ml-cardgrid { grid-template-columns: 1fr; }
  .ml-stage { height: 380px; }
}
`;

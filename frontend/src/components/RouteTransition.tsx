import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { gsap } from 'gsap';

/**
 * "Ginhawa" — the site's default page transition (see Motion Lab,
 * `/motion-lab`, for the full comparison this was picked from).
 *
 * Implemented as a veil that dissolves *off* the new page, rather than a fade
 * that plays *on* the page's own container. That distinction is the whole
 * reason this file looks the way it does.
 *
 * The obvious implementation — tween opacity/y on a wrapper around <main>'s
 * children — stutters, and not for a tunable reason. Every route here renders
 * placeholder content first and swaps in real content when its fetch lands:
 * Courses shows <SkeletonCardGrid> then the real grid, and CmsOrFallback
 * renders the entire hardcoded page then replaces the whole subtree with
 * <BlockRenderer> when a published CMS page arrives. Measured on /courses, that
 * swap lands 305ms into a 500ms tween and changes the wrapper's height by
 * 846px. A relayout that large mid-animation drops frames on its own, and
 * promoting the wrapper (will-change/force3D) makes it worse, not better —
 * it forces a full re-raster of a page-sized compositor layer.
 *
 * The veil sidesteps all of it: an empty fixed-position element with no
 * children never relayouts, so its opacity tween is pure compositor work no
 * matter what the page does underneath. Skeletons still show and still do
 * their job; the content swap happens below the veil instead of inside the
 * animating element. Visually this is near-identical to fading the content in
 * from the page colour — what it gives up is the 14px rise, which is exactly
 * the part that cannot survive a mid-animation reflow.
 *
 * Excluded on purpose:
 *  - /checkout* and /booking/processing, /checkout/processing,
 *    /events/registration/processing — money paths get zero added motion.
 *  - /admin and /facilitator — internal tools, not the marketing site.
 *  - /motion-lab — a design tool; it plays its own demo timelines.
 *  - /courses/:slug and /facilitators/:slug — these get the Flip ("Pamana")
 *    transition from pageFlip.ts as their entrance instead, and a veil
 *    dissolving over a Flip would hide the very thing it animates.
 */
const EXCLUDED = [
  /^\/checkout(\/|$)/,
  /^\/booking\/processing$/,
  /^\/events\/registration\/processing$/,
  /^\/admin(\/|$)/,
  /^\/facilitator(\/|$)/,
  /^\/motion-lab$/,
  /^\/courses\/[^/]+$/,
  /^\/facilitators\/(?!apply$)[^/]+$/,
];

function isExcluded(pathname: string): boolean {
  return EXCLUDED.some((re) => re.test(pathname));
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function RouteTransition({ children }: { children: ReactNode }) {
  const veilRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // Tracks the last path actually transitioned from, so only a real change
  // animates. A plain "have I mounted yet" boolean was not enough: React 19's
  // StrictMode double-invokes effects in development and the ref survives that
  // second pass, so the guard fell through and animated the initial page load
  // — competing with first-paint image and font work, which is exactly when
  // dropped frames are most visible.
  const prevPath = useRef<string | null>(null);

  useLayoutEffect(() => {
    const veil = veilRef.current;
    const changed = prevPath.current !== null && prevPath.current !== pathname;
    prevPath.current = pathname;
    if (!veil || !changed || isExcluded(pathname)) return;

    if (reducedMotion()) {
      const tween = gsap.fromTo(veil, { opacity: 1 }, { opacity: 0, duration: 0.12, ease: 'none' });
      return () => {
        tween.kill();
        gsap.set(veil, { opacity: 0 });
      };
    }

    // Three legs, not two. The two-leg version (cover, then immediately
    // reveal) fixed the hard-cut-to-solid-color problem but traded it for a
    // different one: the reveal started the instant the cover finished, which
    // is also the instant the new route's DOM lands — its initial layout
    // (skeleton or real content, images without decoded dimensions yet, fonts
    // swapping in) is still settling *while* it's being uncovered, so the
    // dissolve exposed that settling instead of a finished page. Holding at
    // full cover for one beat lets that first layout pass finish underneath,
    // unseen, before the reveal begins — the same job a per-page skeleton
    // does, just at the transition layer instead of inside each route.
    const tween = gsap
      .timeline()
      .fromTo(veil, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power1.in' })
      .to(veil, { opacity: 1, duration: 0.12 }) // hold — masks the new route's first layout pass
      .to(veil, { opacity: 0, duration: 0.55, ease: 'power2.out' });
    return () => {
      // Restore the resting state rather than leaving the veil wherever the
      // tween was killed. Navigating again mid-transition into an *excluded*
      // route (clicking a course card while this is still running) would
      // otherwise strand a half-opaque sheet over the page: the next effect
      // returns early and never clears it.
      tween.kill();
      gsap.set(veil, { opacity: 0 });
    };
  }, [pathname]);

  return (
    <>
      <div ref={veilRef} className="route-veil" aria-hidden="true" />
      {children}
    </>
  );
}

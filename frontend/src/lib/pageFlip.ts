import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(Flip);

/**
 * Cross-route GSAP Flip transitions ("Pamana" — see Motion Lab).
 *
 * React Router unmounts the list page before the detail page mounts, so a
 * plain `Flip.from(Flip.getState(...))` can't work: by the time the detail
 * page's effect runs, the list's DOM is gone. Instead:
 *
 *   1. The list page calls `captureFlip()` in a card's onClick, synchronously
 *      before the Link navigates, snapshotting the geometry of every element
 *      carrying `data-flip-id="<kind>-<slug>"`.
 *   2. The detail page calls `playFlip()` after its own matching
 *      `data-flip-id` elements are in the DOM. GSAP Flip pairs "from" and
 *      "to" elements by that attribute (not by identity), so the two pages
 *      never need to share a component instance.
 *
 * The captured state is a module-level singleton, not per-slug: a click log
 * of one pending transition is all that's ever needed, and clearing it after
 * either a successful play or a mismatched slug prevents a stale snapshot
 * from firing on some unrelated later navigation (e.g. hitting Back).
 */

let pending: Flip.FlipState | null = null;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Call synchronously inside a card's onClick, before the Link navigates. */
export function captureFlip(scope: Element | null): void {
  if (!scope || reducedMotion()) return;
  const els = scope.querySelectorAll('[data-flip-id]');
  if (!els.length) return;
  pending = Flip.getState(els, { props: 'borderRadius' });
}

/**
 * Call from the detail page once its `data-flip-id` elements are mounted
 * (a `useLayoutEffect`, so it runs before paint). Consumes the captured
 * state — a second call (e.g. a re-render) is a no-op rather than replaying.
 */
export function playFlip(scope: Element | null): void {
  const state = pending;
  pending = null;
  if (!state || !scope) return;
  const targets = scope.querySelectorAll('[data-flip-id]');
  if (!targets.length) return;
  Flip.from(state, {
    targets,
    duration: 0.6,
    ease: 'expo.out',
    absolute: true,
    scale: true,
    fade: true,
    props: 'borderRadius',
  });
}

/** Drop a stale capture — call on unmount of a list page, just in case. */
export function clearPendingFlip(): void {
  pending = null;
}

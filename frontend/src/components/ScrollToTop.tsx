import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * React Router keeps the scroll position when it swaps route elements, so
 * following an internal link from halfway down one page left you halfway down
 * the next. Reset to the top whenever the path changes — but not on pure hash
 * changes, so in-page anchor links still work.
 *
 * This must be a *layout* effect, not a passive one. As a passive effect it
 * ran after the browser had already painted the new route at the previous
 * page's scroll offset, so every navigation from below the fold showed one
 * frame at the wrong position and then jumped — which read as a stutter once
 * RouteTransition's entrance tween (a layout effect, so already underway) was
 * animating through that jump. Running before paint makes the scroll reset
 * and the transition's first frame part of the same commit.
 *
 * Ordering matters and is load-bearing: React flushes layout effects
 * depth-first, siblings left to right, and <ScrollToTop /> is rendered before
 * <Routes> in App.tsx — so the scroll lands before RouteTransition sets its
 * start state and before ProductDetail/FacilitatorProfile measure geometry
 * for their Flip transition.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

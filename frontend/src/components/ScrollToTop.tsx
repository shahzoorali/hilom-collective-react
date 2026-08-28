import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * React Router keeps the scroll position when it swaps route elements, so
 * following an internal link from halfway down one page left you halfway down
 * the next. Reset to the top whenever the path changes — but not on pure hash
 * changes, so in-page anchor links still work.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

/**
 * The signed-in user as React state.
 *
 * `currentUser()` reads sessionStorage, so a component calling it directly gets
 * whatever was true at its last render and never hears about a change. That was
 * survivable while the only transitions were "arrived signed in" and "clicked
 * log out" (a full page load either way), but a background token refresh
 * reissues the id_token in place — and a session that ends for real now does so
 * without navigating. Both need the header to notice.
 */
import { useEffect, useState } from 'react';
import { AUTH_EVENT, currentUser, type HilomUser } from './auth';

export function useCurrentUser(): HilomUser | null {
  const [user, setUser] = useState<HilomUser | null>(() => currentUser());

  useEffect(() => {
    const sync = () => setUser(currentUser());
    window.addEventListener(AUTH_EVENT, sync);
    // The refresh happens in this tab, but a sign-out in another one is worth
    // following too — sessionStorage is per-tab, `storage` fires for neither,
    // so this is only the belt for `focus`: re-read whenever we come back.
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(AUTH_EVENT, sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  return user;
}

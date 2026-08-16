/**
 * Loads the site menus once per page load, with the original hardcoded nav as
 * the fallback.
 *
 * The fallback is load-bearing, not defensive decoration: the admin menu save
 * replaces a menu's items with a delete-then-insert, so there is a brief window
 * where a menu reads as empty. A visitor landing in that window gets the
 * built-in nav rather than a header with no links.
 */
import { useEffect, useState } from 'react';
import { getMenus, type MenuLink } from '../lib/cms';
import { MOODLE_URL } from '../config';

const link = (label: string, href: string, target: 'self' | 'blank' = 'self'): MenuLink => ({
  label,
  href,
  target,
  children: [],
});

/** Mirrors what Layout.tsx rendered before menus were editable. */
export const FALLBACK_HEADER: MenuLink[] = [
  link('About Hilom', '/about'),
  link('Services', '/services'),
  link('Events', '/events'),
  link('Join Our Community', '/community'),
  link('Courses', '/courses'),
  link('Login to Hilom Learning Hub ➞', MOODLE_URL, 'blank'),
];

export const FALLBACK_FOOTER: MenuLink[] = [link('Learning platform', MOODLE_URL, 'blank')];

let cache: Record<string, MenuLink[]> | null = null;

export function useMenus(): Record<string, MenuLink[]> {
  const [menus, setMenus] = useState<Record<string, MenuLink[]> | null>(cache);

  useEffect(() => {
    if (cache) return;
    let live = true;
    getMenus()
      .then((loaded) => {
        cache = loaded;
        if (live) setMenus(loaded);
      })
      .catch(() => {
        /* falls through to the hardcoded menus below */
      });
    return () => {
      live = false;
    };
  }, []);

  return {
    header: menus?.header?.length ? menus.header : FALLBACK_HEADER,
    footer: menus?.footer?.length ? menus.footer : FALLBACK_FOOTER,
  };
}

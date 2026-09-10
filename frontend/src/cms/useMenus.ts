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
import { coerceFooter, DEFAULT_FOOTER, type FooterSettings } from '../lib/footer';
import { MOODLE_URL } from '../config';

const link = (
  label: string,
  href: string,
  target: 'self' | 'blank' = 'self',
  style: 'link' | 'button' = 'link',
): MenuLink => ({
  label,
  href,
  target,
  style,
  children: [],
});

/** Mirrors what Layout.tsx rendered before menus were editable. */
export const FALLBACK_HEADER: MenuLink[] = [
  link('About Hilom', '/about'),
  link('Services', '/services'),
  link('Events', '/events'),
  link('Courses', '/courses'),
  link('Login to Hilom Learning Hub ➞', MOODLE_URL, 'blank'),
  link('Join our community', '/community', 'self', 'button'),
];

export const FALLBACK_FOOTER: MenuLink[] = [
  link('Learning platform', MOODLE_URL, 'blank'),
  link('Privacy Policy', '/privacy-policy'),
];

interface SiteChrome {
  menus: Record<string, MenuLink[]>;
  settings: Record<string, unknown>;
}

let cache: SiteChrome | null = null;

export interface Chrome {
  header: MenuLink[];
  footer: MenuLink[];
  /** Every menu by key, so a footer "menu" widget can name one other than 'footer'. */
  byKey: Record<string, MenuLink[]>;
  /** The editable footer, defaulted to what Layout.tsx used to hardcode. */
  footerSettings: FooterSettings;
}

export function useMenus(): Chrome {
  const [chrome, setChrome] = useState<SiteChrome | null>(cache);

  useEffect(() => {
    if (cache) return;
    let live = true;
    getMenus()
      .then((loaded) => {
        const next = { menus: loaded.menus ?? {}, settings: loaded.settings ?? {} };
        cache = next;
        if (live) setChrome(next);
      })
      .catch(() => {
        /* falls through to the hardcoded menus and footer below */
      });
    return () => {
      live = false;
    };
  }, []);

  const menus = chrome?.menus;
  const footerValue = chrome?.settings?.footer;

  return {
    header: menus?.header?.length ? menus.header : FALLBACK_HEADER,
    footer: menus?.footer?.length ? menus.footer : FALLBACK_FOOTER,
    byKey: menus ?? {},
    // Absent means nobody has edited the footer — see the note in footer.ts on
    // why that renders the built-in footer rather than an empty one.
    footerSettings: footerValue ? coerceFooter(footerValue) : DEFAULT_FOOTER,
  };
}

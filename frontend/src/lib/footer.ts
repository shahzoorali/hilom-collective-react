/**
 * The footer's shape, and what it contains until someone edits it.
 *
 * The default below is the footer that was hardcoded in `Layout.tsx` — the
 * same four columns, in the same order, with the same copy. It is kept as a
 * default rather than seeded into the database so that a fresh environment, a
 * failed settings read, and a footer nobody has touched all render what
 * visitors see today instead of an empty band.
 *
 * That makes the default load-bearing, exactly like FALLBACK_HEADER in
 * useMenus.ts: an admin saving the footer replaces the whole value, so the
 * only thing standing between a failed request and a blank footer is this.
 */
import { MOODLE_URL } from '../config';

export interface FooterLink {
  label: string;
  href: string;
  target: 'self' | 'blank';
}

export type FooterWidget =
  | { id: string; type: 'brand'; headline: string; cta_label: string; cta_href: string }
  | { id: string; type: 'links'; title: string; links: FooterLink[] }
  | { id: string; type: 'text'; title: string; text: string }
  | {
      id: string;
      type: 'contact';
      title: string;
      email: string;
      address: string;
      socials: FooterLink[];
    }
  /** Rendered from an editable menu (Admin → Menus), so legal links stay in one place. */
  | { id: string; type: 'menu'; title: string; menu_key: string };

export interface FooterSettings {
  widgets: FooterWidget[];
  legal_lines: string[];
}

export const FOOTER_WIDGET_TYPES: { value: FooterWidget['type']; label: string; hint: string }[] = [
  { value: 'brand', label: 'Brand & call to action', hint: 'Logo, closing line, one button.' },
  { value: 'links', label: 'Link list', hint: 'A titled column of links you type here.' },
  { value: 'menu', label: 'Menu', hint: 'A column rendered from a menu in Admin → Menus.' },
  { value: 'contact', label: 'Contact', hint: 'Email, location, and social icons.' },
  { value: 'text', label: 'Text', hint: 'A titled column of prose.' },
];

const link = (label: string, href: string, target: 'self' | 'blank' = 'self'): FooterLink => ({
  label,
  href,
  target,
});

/** Mirrors what Layout.tsx rendered before the footer became editable. */
export const DEFAULT_FOOTER: FooterSettings = {
  widgets: [
    {
      id: 'brand',
      type: 'brand',
      // Two lines, as it is set on the home page hero. The break is stored in
      // the value rather than forced by the stylesheet, so a footer headline
      // of a different length is not stuck with a break in the wrong place.
      headline: 'Paghilom.\nPara sa lahat.',
      cta_label: 'Join our community',
      cta_href: '/community',
    },
    {
      id: 'contact',
      type: 'contact',
      title: 'Get in touch',
      email: 'kumusta@hilomcollective.com',
      address: 'Metro Manila, Philippines',
      socials: [
        link('f', 'https://www.facebook.com/hilomcollective', 'blank'),
        link('ig', 'https://www.instagram.com/hilomcollective/', 'blank'),
        link('tt', 'https://www.tiktok.com/@hilom.collective', 'blank'),
      ],
    },
    {
      id: 'explore',
      type: 'links',
      title: 'Explore',
      links: [
        link('About Hilom', '/about'),
        link('Services', '/services'),
        link('Courses', '/courses'),
        link('Facilitators', '/facilitators'),
        link('Events', '/events'),
        link('Journal', '/blog'),
      ],
    },
    // The legal and platform links, which stayed a menu on purpose: they are
    // edited alongside the header nav, and duplicating them here would mean
    // two places to change a privacy-policy URL.
    { id: 'more', type: 'menu', title: 'More', menu_key: 'footer' },
  ],
  legal_lines: [
    `© ${new Date().getFullYear()} Hilom Collective. All rights reserved.`,
    'A holistic wellness platform rooted in Filipino life.',
  ],
};

/** A blank widget of each type, for the editor's "add" button. */
export function emptyWidget(type: FooterWidget['type'], id: string): FooterWidget {
  switch (type) {
    case 'brand':
      return { id, type, headline: '', cta_label: '', cta_href: '' };
    case 'links':
      return { id, type, title: '', links: [] };
    case 'text':
      return { id, type, title: '', text: '' };
    case 'contact':
      return { id, type, title: '', email: '', address: '', socials: [] };
    default:
      return { id, type: 'menu', title: '', menu_key: 'footer' };
  }
}

/**
 * A stored value, made safe to render.
 *
 * Anything unrecognised falls back to the default rather than rendering a
 * broken footer — a value written by an older or newer version of the editor
 * must not be able to take the site's footer down.
 */
export function coerceFooter(value: unknown): FooterSettings {
  if (!value || typeof value !== 'object') return DEFAULT_FOOTER;
  const raw = value as Partial<FooterSettings>;
  if (!Array.isArray(raw.widgets) || raw.widgets.length === 0) return DEFAULT_FOOTER;
  return {
    widgets: raw.widgets.filter((w): w is FooterWidget => Boolean(w) && typeof w.type === 'string'),
    legal_lines: Array.isArray(raw.legal_lines) ? raw.legal_lines : [],
  };
}

/** The Moodle link the default footer menu carries, for the editor's help text. */
export const LEARNING_PLATFORM_URL = MOODLE_URL;

/**
 * Validation for `site_settings` values.
 *
 * Today that is the footer: an ordered list of widgets plus the legal lines
 * under them. The footer used to be markup in `Layout.tsx` — a brand column, a
 * contact column, an "Explore" list, and one CMS-driven menu — and every one
 * of those is now a widget of some type, so nothing about the rendered footer
 * had to change for it to become editable.
 *
 * Everything here is coerced rather than trusted. The values are written by an
 * admin and rendered on every page for every visitor, so a bad `href` is a
 * site-wide `javascript:` link, not a broken row in one table. The href rule is
 * deliberately the same one `admin-menus.ts` applies to menu items.
 */
import { stripTags } from './sanitize.js';

export class SiteSettingError extends Error {}

export interface FooterLink {
  label: string;
  href: string;
  target: 'self' | 'blank';
}

export type FooterWidget =
  /** Logo, closing line, and the one call to action. */
  | { id: string; type: 'brand'; headline: string; cta_label: string; cta_href: string }
  /** A titled column of links. */
  | { id: string; type: 'links'; title: string; links: FooterLink[] }
  /** A titled column of prose. */
  | { id: string; type: 'text'; title: string; text: string }
  /** How to reach a person, plus the social icons. */
  | {
      id: string;
      type: 'contact';
      title: string;
      email: string;
      address: string;
      socials: FooterLink[];
    }
  /** A column rendered from an editable menu (Admin → Menus), by key. */
  | { id: string; type: 'menu'; title: string; menu_key: string };

export interface FooterSettings {
  widgets: FooterWidget[];
  /** The small print under the columns. */
  legal_lines: string[];
}

const WIDGET_TYPES = new Set(['brand', 'links', 'text', 'contact', 'menu']);
const MAX_WIDGETS = 8;
const MAX_LINKS = 20;

const text = (value: unknown, max: number): string => stripTags(String(value ?? '')).trim().slice(0, max);

/** Site paths, absolute http(s) URLs, mailto: and in-page anchors. Nothing else. */
function href(value: unknown, path: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^(https?:\/\/|\/|mailto:|tel:|#)/i.test(raw)) {
    throw new SiteSettingError(`${path} must be a site path (/about), an https URL, or mailto:`);
  }
  return raw.slice(0, 500);
}

function link(raw: unknown, path: string): FooterLink {
  if (typeof raw !== 'object' || raw === null) throw new SiteSettingError(`${path} must be an object`);
  const item = raw as Record<string, unknown>;
  const label = text(item.label, 120);
  if (!label) throw new SiteSettingError(`${path}.label is required`);
  const target = item.target === 'blank' ? 'blank' : 'self';
  return { label, href: href(item.href, `${path}.href`), target };
}

function links(raw: unknown, path: string): FooterLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_LINKS).map((item, i) => link(item, `${path}[${i}]`));
}

/**
 * Ids exist so the editor can key and reorder rows without them jumping as
 * titles are typed. They are opaque to the backend, and a missing one is
 * filled in rather than rejected — a footer is not worth failing a save over.
 */
function widgetId(value: unknown, index: number): string {
  const id = String(value ?? '').trim().slice(0, 40);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `w${index}`;
}

function widget(raw: unknown, index: number): FooterWidget {
  const path = `widgets[${index}]`;
  if (typeof raw !== 'object' || raw === null) throw new SiteSettingError(`${path} must be an object`);
  const w = raw as Record<string, unknown>;

  const type = String(w.type ?? '');
  if (!WIDGET_TYPES.has(type)) throw new SiteSettingError(`${path}.type "${type}" is not a footer widget`);
  const id = widgetId(w.id, index);

  switch (type) {
    case 'brand':
      return {
        id,
        type: 'brand',
        headline: text(w.headline, 200),
        cta_label: text(w.cta_label, 60),
        cta_href: href(w.cta_href, `${path}.cta_href`),
      };
    case 'links':
      return { id, type: 'links', title: text(w.title, 60), links: links(w.links, `${path}.links`) };
    case 'text':
      return { id, type: 'text', title: text(w.title, 60), text: text(w.text, 2000) };
    case 'contact':
      return {
        id,
        type: 'contact',
        title: text(w.title, 60),
        email: text(w.email, 160),
        address: text(w.address, 200),
        socials: links(w.socials, `${path}.socials`),
      };
    default:
      return {
        id,
        type: 'menu',
        title: text(w.title, 60),
        // Which menu to render. Not checked against the menus table here: a
        // key that names no menu renders as an empty column, where a hard
        // error would block the whole footer save on an unrelated typo.
        menu_key: text(w.menu_key, 40) || 'footer',
      };
  }
}

export function validateFooter(body: Record<string, unknown>): FooterSettings {
  const rawWidgets = body.widgets;
  if (!Array.isArray(rawWidgets)) throw new SiteSettingError('widgets must be an array');
  if (rawWidgets.length > MAX_WIDGETS) {
    throw new SiteSettingError(`a footer cannot have more than ${MAX_WIDGETS} widgets`);
  }

  const legal = Array.isArray(body.legal_lines) ? body.legal_lines : [];

  return {
    widgets: rawWidgets.map(widget),
    legal_lines: legal.slice(0, 4).map((line) => text(line, 300)).filter(Boolean),
  };
}

/** The one key this file knows how to validate. */
export const SITE_SETTING_VALIDATORS: Record<
  string,
  (body: Record<string, unknown>) => Record<string, unknown>
> = {
  footer: (body) => validateFooter(body) as unknown as Record<string, unknown>,
};

/**
 * GET /menus — every menu at once, keyed by menu key ('header', 'footer'),
 * plus the editable site settings the layout needs (the footer's widgets).
 *
 * One request rather than one per menu: the site layout needs all of it on
 * every page load, and a second round-trip before the header can render is a
 * visible flash of an empty nav. The footer settings ride along for exactly
 * the same reason — they are read by the same component, on the same paint.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, serverError } from '../lib/http.js';

interface MenuItemRow {
  id: string;
  menu_id: string;
  parent_id: string | null;
  position: number;
  label: string;
  href: string;
  target: string;
  style: string;
}

export async function handler(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();

    const [
      { data: menus, error: menusError },
      { data: items, error: itemsError },
      { data: settings, error: settingsError },
    ] = await Promise.all([
      supabase.from('menus').select('id, key, label'),
      supabase
        .from('menu_items')
        .select('id, menu_id, parent_id, position, label, href, target, style')
        .eq('visible', true)
        .order('position'),
      supabase.from('site_settings').select('key, value'),
    ]);

    if (menusError) throw menusError;
    if (itemsError) throw itemsError;
    if (settingsError) throw settingsError;

    const byMenu: Record<string, unknown[]> = {};
    for (const menu of menus ?? []) {
      const own = ((items ?? []) as MenuItemRow[]).filter((i) => i.menu_id === menu.id);
      // Children are nested under their parent; an item whose parent is hidden
      // is dropped with it rather than being promoted to the top level.
      const tops = own.filter((i) => !i.parent_id);
      byMenu[menu.key] = tops.map((i) => ({
        label: i.label,
        href: i.href,
        target: i.target,
        style: i.style,
        children: own
          .filter((c) => c.parent_id === i.id)
          .map((c) => ({ label: c.label, href: c.href, target: c.target, style: c.style })),
      }));
    }

    // Keyed by setting name, and absent when nobody has edited it. The client
    // has the current footer as its default (frontend/src/lib/footer.ts), so
    // "no row" and "never edited" render identically rather than emptily.
    const bySetting: Record<string, unknown> = {};
    for (const row of (settings ?? []) as { key: string; value: unknown }[]) {
      bySetting[row.key] = row.value;
    }

    return ok({ menus: byMenu, settings: bySetting });
  } catch (err) {
    return serverError('menus.get', err);
  }
}

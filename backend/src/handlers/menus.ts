/**
 * GET /menus — every menu at once, keyed by menu key ('header', 'footer').
 *
 * One request rather than one per menu: the site layout needs both on every
 * page load, and two round-trips before the header can render is a visible
 * flash of an empty nav.
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
}

export async function handler(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();

    const [{ data: menus, error: menusError }, { data: items, error: itemsError }] =
      await Promise.all([
        supabase.from('menus').select('id, key, label'),
        supabase
          .from('menu_items')
          .select('id, menu_id, parent_id, position, label, href, target')
          .eq('visible', true)
          .order('position'),
      ]);

    if (menusError) throw menusError;
    if (itemsError) throw itemsError;

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
        children: own
          .filter((c) => c.parent_id === i.id)
          .map((c) => ({ label: c.label, href: c.href, target: c.target })),
      }));
    }

    return ok({ menus: byMenu });
  } catch (err) {
    return serverError('menus.get', err);
  }
}

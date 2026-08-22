/**
 * Admin menu management.
 *
 *   GET /admin/menus         — every menu with its items, including hidden ones
 *   PUT /admin/menus/{key}   — replace one menu's items wholesale
 *
 * The update is a whole-menu replace rather than per-item CRUD. The editor holds
 * the entire ordered list in state and a drag-reorder changes most positions at
 * once, so a diff/upsert/delete reconciliation would be more code and more ways
 * to end up with a half-applied order.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { stripTags } from '../lib/sanitize.js';

interface IncomingItem {
  label: string;
  href: string;
  target: 'self' | 'blank';
  visible: boolean;
  children: IncomingItem[];
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const key = event.pathParameters?.key;
  try {
    if (!key) return await list();
    return await replace(key, event);
  } catch (err) {
    return serverError('adminMenus', err);
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const [{ data: menus, error: menusError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from('menus').select('id, key, label').order('key'),
    supabase
      .from('menu_items')
      .select('id, menu_id, parent_id, position, label, href, target, visible')
      .order('position'),
  ]);

  if (menusError) throw menusError;
  if (itemsError) throw itemsError;

  return ok({
    menus: (menus ?? []).map((menu) => {
      const own = (items ?? []).filter((i) => i.menu_id === menu.id);
      return {
        key: menu.key,
        label: menu.label,
        items: own
          .filter((i) => !i.parent_id)
          .map((i) => ({
            label: i.label,
            href: i.href,
            target: i.target,
            visible: i.visible,
            children: own
              .filter((c) => c.parent_id === i.id)
              .map((c) => ({ label: c.label, href: c.href, target: c.target, visible: c.visible })),
          })),
      };
    }),
  });
}

/** Menu hrefs are site paths or absolute URLs — never `javascript:`. */
function coerceItem(raw: unknown, path: string): IncomingItem {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} must be an object`);
  const item = raw as Record<string, unknown>;

  const label = stripTags(String(item.label ?? '')).trim();
  const href = String(item.href ?? '').trim();
  if (!label) throw new Error(`${path}.label is required`);
  if (!/^(https?:\/\/|\/|mailto:|#)/i.test(href)) {
    throw new Error(`${path}.href must be a site path (/about) or an https URL`);
  }

  return {
    label: label.slice(0, 120),
    href: href.slice(0, 500),
    target: item.target === 'blank' ? 'blank' : 'self',
    visible: item.visible === undefined ? true : Boolean(item.visible),
    children: Array.isArray(item.children)
      ? item.children.slice(0, 20).map((c, i) => coerceItem(c, `${path}.children[${i}]`))
      : [],
  };
}

async function replace(key: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let incoming: IncomingItem[];
  try {
    const body: unknown = JSON.parse(event.body ?? '{}');
    const rawItems = (body as { items?: unknown }).items;
    if (!Array.isArray(rawItems)) return badRequest('items must be an array');
    if (rawItems.length > 30) return badRequest('a menu cannot have more than 30 top-level items');
    incoming = rawItems.map((item, i) => coerceItem(item, `items[${i}]`));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'Invalid request body');
  }

  const supabase = await getSupabase();
  const { data: menu, error: menuError } = await supabase
    .from('menus')
    .select('id')
    .eq('key', key)
    .maybeSingle();

  if (menuError) throw menuError;
  if (!menu) return notFound(`No menu named "${key}"`);

  // Delete-then-insert. Between the two statements the menu is empty, which is
  // why Layout.tsx keeps a hardcoded fallback: a reader landing in that window
  // gets the built-in nav rather than a header with no links.
  const { error: deleteError } = await supabase.from('menu_items').delete().eq('menu_id', menu.id);
  if (deleteError) throw deleteError;

  for (const [position, item] of incoming.entries()) {
    const { data: parent, error } = await supabase
      .from('menu_items')
      .insert({
        menu_id: menu.id,
        position,
        label: item.label,
        href: item.href,
        target: item.target,
        visible: item.visible,
      })
      .select('id')
      .maybeSingle();

    if (error) throw error;

    if (item.children.length && parent) {
      const { error: childError } = await supabase.from('menu_items').insert(
        item.children.map((child, childPosition) => ({
          menu_id: menu.id,
          parent_id: parent.id,
          position: childPosition,
          label: child.label,
          href: child.href,
          target: child.target,
          visible: child.visible,
        })),
      );
      if (childError) throw childError;
    }
  }

  return list();
}

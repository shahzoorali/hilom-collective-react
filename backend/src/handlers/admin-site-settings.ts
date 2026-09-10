/**
 * Admin site settings.
 *
 *   GET /admin/site-settings         — every setting, keyed by name
 *   PUT /admin/site-settings/{key}   — replace one setting's value wholesale
 *
 * A whole-value replace, like the menu editor next door: the editor holds the
 * complete footer in state and a reorder changes most of it at once, so a
 * per-widget patch API would be more code and more ways to end up with a
 * half-applied footer.
 *
 * The public read is not here — it rides along with `GET /menus`, which the
 * layout already fetches on every page load.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { SITE_SETTING_VALIDATORS, SiteSettingError } from '../lib/site-settings.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const key = event.pathParameters?.key;
  try {
    if (!key) return await list();
    return await replace(key, event);
  } catch (err) {
    if (err instanceof SiteSettingError) return badRequest(err.message);
    return serverError('adminSiteSettings', err);
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('site_settings').select('key, value, updated_at');
  if (error) throw error;

  const settings: Record<string, unknown> = {};
  for (const row of data ?? []) settings[row.key] = row.value;
  return ok({ settings });
}

async function replace(key: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const validate = SITE_SETTING_VALIDATORS[key];
  // An unknown key is rejected rather than stored: the point of this table is
  // a handful of known, validated settings, not an untyped key/value store an
  // admin screen can write anything into.
  if (!validate) return badRequest(`"${key}" is not an editable site setting`);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  } catch {
    return badRequest('Invalid request body');
  }

  const value = validate(body);

  const supabase = await getSupabase();
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;

  return ok({ settings: { [key]: value } });
}

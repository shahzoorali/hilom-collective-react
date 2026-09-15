/**
 * Admin promo code management.
 *
 *   GET    /admin/promo-codes
 *   POST   /admin/promo-codes
 *   PATCH  /admin/promo-codes/{promoCodeId}
 *   DELETE /admin/promo-codes/{promoCodeId}
 *
 * Deletion is a real delete, not a soft one: `orders.promo_code_id` is
 * `ON DELETE SET NULL` (0044), so a historical order keeps the
 * `discount_centavos` it actually charged even after the code that produced
 * it is gone. There is nothing else that references a promo code.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';

const COLUMNS = 'id, code, label, discount_type, discount_value, is_active, expires_at, created_at, updated_at';

interface PromoCodeBody {
  code?: string;
  label?: string | null;
  discount_type?: string;
  discount_value?: number;
  is_active?: boolean;
  expires_at?: string | null;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const promoCodeId = event.pathParameters?.promoCodeId;

  try {
    if (!promoCodeId) {
      if (method === 'GET') return await list();
      if (method === 'POST') return await create(parseBody(event));
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'PATCH') return await update(promoCodeId, parseBody(event));
    if (method === 'DELETE') return await remove(promoCodeId);
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof ValidationError) return badRequest(err.message);
    return serverError('adminPromoCodes', err);
  }
}

class ValidationError extends Error {}

function parseBody(event: APIGatewayProxyEventV2): PromoCodeBody {
  try {
    return JSON.parse(event.body ?? '{}') as PromoCodeBody;
  } catch {
    throw new ValidationError('Malformed body');
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('promo_codes')
    .select(COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ok({ promoCodes: data ?? [] });
}

/**
 * Shared by create and update: validates whichever fields are present and
 * returns a patch object. `code` and `discount_type` are required on create
 * (checked by the caller, since a patch legitimately omits them).
 */
function buildPatch(body: PromoCodeBody, opts: { requireCore: boolean }): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (body.code !== undefined) {
    const code = body.code.trim().toUpperCase();
    if (!code || !/^[A-Z0-9_-]{2,40}$/.test(code)) {
      throw new ValidationError('Code must be 2-40 characters: letters, numbers, - or _');
    }
    patch.code = code;
  } else if (opts.requireCore) {
    throw new ValidationError('code is required');
  }

  if (body.label !== undefined) patch.label = body.label?.trim() || null;

  const discountType = body.discount_type;
  if (discountType !== undefined) {
    if (discountType !== 'percent' && discountType !== 'fixed') {
      throw new ValidationError('discount_type must be "percent" or "fixed"');
    }
    patch.discount_type = discountType;
  } else if (opts.requireCore) {
    throw new ValidationError('discount_type is required');
  }

  if (body.discount_value !== undefined) {
    const value = body.discount_value;
    if (!Number.isInteger(value)) throw new ValidationError('discount_value must be an integer');
    const type = (patch.discount_type as string | undefined) ?? discountType;
    if (type === 'percent' && (value < 1 || value > 100)) {
      throw new ValidationError('A percent discount must be between 1 and 100');
    }
    if (type === 'fixed' && value < 0) {
      throw new ValidationError('A fixed discount (centavos) cannot be negative');
    }
    patch.discount_value = value;
  } else if (opts.requireCore) {
    throw new ValidationError('discount_value is required');
  }

  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
  if (body.expires_at !== undefined) {
    if (body.expires_at === null || body.expires_at === '') {
      patch.expires_at = null;
    } else if (!Number.isNaN(Date.parse(body.expires_at))) {
      patch.expires_at = body.expires_at;
    } else {
      throw new ValidationError('expires_at must be a valid date, or null to clear it');
    }
  }

  return patch;
}

async function create(body: PromoCodeBody): Promise<APIGatewayProxyResultV2> {
  const patch = buildPatch(body, { requireCore: true });

  const supabase = await getSupabase();
  const { data, error } = await supabase.from('promo_codes').insert(patch).select(COLUMNS).maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return badRequest('That code already exists');
    }
    throw error;
  }
  return ok({ promoCode: data });
}

async function update(promoCodeId: string, body: PromoCodeBody): Promise<APIGatewayProxyResultV2> {
  const patch = buildPatch(body, { requireCore: false });
  if (Object.keys(patch).length === 0) return badRequest('No updatable fields provided');

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('promo_codes')
    .update(patch)
    .eq('id', promoCodeId)
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return badRequest('That code already exists');
    }
    throw error;
  }
  if (!data) return notFound('Promo code not found');
  return ok({ promoCode: data });
}

async function remove(promoCodeId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error, count } = await supabase
    .from('promo_codes')
    .delete({ count: 'exact' })
    .eq('id', promoCodeId);
  if (error) throw error;
  if (!count) return notFound('Promo code not found');
  return ok({ deleted: true });
}

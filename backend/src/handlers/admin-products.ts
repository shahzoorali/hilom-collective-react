/**
 * Admin product management.
 *
 * Prices live in the database rather than in code so they can be corrected
 * without a deploy — which matters because a wrong price is a live commercial
 * problem, not a code problem.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, notFound, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';

/** GET /admin/products — every product, including inactive ones. */
export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('products')
      .select('id, name, slug, description, price_centavos, currency, is_active, product_courses(moodle_course_id)')
      .order('price_centavos', { ascending: true });

    if (error) throw error;
    return ok({ products: data ?? [] });
  } catch (err) {
    return serverError('adminProducts.list', err);
  }
}

interface UpdateBody {
  price_centavos?: number;
  name?: string;
  description?: string;
  is_active?: boolean;
}

/**
 * PATCH /admin/products/{productId}
 *
 * Only the fields present in the body are changed. Price is validated as a
 * non-negative integer: PayMongo works in centavos, and a fractional or
 * negative amount would be rejected at checkout — better to refuse it here
 * than to discover it when a customer tries to pay.
 */
export async function update(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const productId = event.pathParameters?.productId;
  if (!productId) return badRequest('Missing productId');

  let body: UpdateBody;
  try {
    body = JSON.parse(event.body ?? '{}') as UpdateBody;
  } catch {
    return badRequest('Malformed body');
  }

  const patch: Record<string, unknown> = {};

  if (body.price_centavos !== undefined) {
    const price = body.price_centavos;
    if (!Number.isInteger(price) || price < 0) {
      return badRequest('price_centavos must be a non-negative integer (centavos, not pesos)');
    }
    patch.price_centavos = price;
  }
  if (body.name !== undefined) {
    if (!body.name.trim()) return badRequest('name cannot be empty');
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) patch.description = body.description;
  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);

  if (Object.keys(patch).length === 0) return badRequest('No updatable fields provided');

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('products')
      .update(patch)
      .eq('id', productId)
      .select('id, name, slug, price_centavos, currency, is_active')
      .maybeSingle();

    if (error) throw error;
    if (!data) return notFound(`Product ${productId} not found`);

    // Deliberately does not touch existing orders: they store amount_centavos
    // at time of purchase, so a later price change never rewrites what someone
    // was actually charged.
    return ok({ product: data });
  } catch (err) {
    return serverError('adminProducts.update', err);
  }
}

/**
 * Admin product management.
 *
 * Prices live in the database rather than in code so they can be corrected
 * without a deploy — which matters because a wrong price is a live commercial
 * problem, not a code problem.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { normalizeSlugFormat, SlugError } from '../lib/slug.js';
import { ok, badRequest, notFound, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { actorFromEvent, recordAudit } from '../lib/audit.js';

/** GET /admin/products — every product, including inactive ones. */
export async function list(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('products')
      .select(
        'id, name, slug, description, price_centavos, currency, thumbnail_url, is_active, product_courses(moodle_course_id)',
      )
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
  /** Absolute URL, or null/"" to clear and fall back to the Moodle image. */
  thumbnail_url?: string | null;
  /**
   * Public URL slug (`/products/<slug>`). Auto-drafted products get an ugly
   * slug from the Moodle shortname (e.g. `hilomca1`); this lets an admin set a
   * readable one. Kebab-case only, and unique across products.
   */
  slug?: string;
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
  if (body.slug !== undefined) {
    try {
      patch.slug = normalizeSlugFormat(body.slug);
    } catch (err) {
      return badRequest(err instanceof SlugError ? err.message : 'Invalid slug');
    }
  }
  if (body.description !== undefined) patch.description = body.description;
  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
  if (body.thumbnail_url !== undefined) {
    const raw = body.thumbnail_url;
    if (raw === null || raw === '') {
      patch.thumbnail_url = null;
    } else if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
      patch.thumbnail_url = raw.trim();
    } else {
      return badRequest('thumbnail_url must be an absolute http(s) URL, or null to clear it');
    }
  }

  if (Object.keys(patch).length === 0) return badRequest('No updatable fields provided');

  try {
    const supabase = await getSupabase();
    // Read first so the audit row can say what the price or visibility was.
    const { data: before } = await supabase
      .from('products')
      .select('name, price_centavos, currency, is_active')
      .eq('id', productId)
      .maybeSingle<{ name: string; price_centavos: number; currency: string; is_active: boolean }>();

    const { data, error } = await supabase
      .from('products')
      .update(patch)
      .eq('id', productId)
      .select('id, name, slug, description, price_centavos, currency, thumbnail_url, is_active')
      .maybeSingle();

    if (error) {
      // 23505 = unique_violation, i.e. another product already has this slug.
      if ((error as { code?: string }).code === '23505') {
        return badRequest('That slug is already used by another product');
      }
      throw error;
    }
    if (!data) return notFound(`Product ${productId} not found`);

    // Deliberately does not touch existing orders: they store amount_centavos
    // at time of purchase, so a later price change never rewrites what someone
    // was actually charged.

    // Price and visibility only: those change what customers pay and whether
    // they can buy at all. Copy, slug and image edits are not audited.
    const priceChanged = before && patch.price_centavos !== undefined && patch.price_centavos !== before.price_centavos;
    const visibilityChanged = before && patch.is_active !== undefined && patch.is_active !== before.is_active;
    if (before && (priceChanged || visibilityChanged)) {
      await recordAudit(actorFromEvent(event), {
        action: priceChanged ? 'product.price_changed' : 'product.visibility_changed',
        targetTable: 'products',
        targetId: productId,
        amountCentavos: priceChanged ? (patch.price_centavos as number) : null,
        currency: before.currency,
        before: { price_centavos: before.price_centavos, is_active: before.is_active },
        after: {
          price_centavos: patch.price_centavos ?? before.price_centavos,
          is_active: patch.is_active ?? before.is_active,
        },
        note: before.name,
      });
    }
    return ok({ product: data });
  } catch (err) {
    return serverError('adminProducts.update', err);
  }
}

/**
 * GET /products        — active catalog
 * GET /products/{slug} — product detail, including the courses it grants
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase, type Product } from '../lib/supabase.js';
import { ok, notFound, serverError } from '../lib/http.js';

export async function list(): Promise<APIGatewayProxyResultV2> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('products')
      .select('id, name, slug, description, price_centavos, currency, thumbnail_url')
      .eq('is_active', true)
      .order('price_centavos', { ascending: true });

    if (error) throw error;
    return ok({ products: data ?? [] });
  } catch (err) {
    return serverError('products.list', err);
  }
}

export async function detail(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const slug = event.pathParameters?.slug;
  if (!slug) return notFound('Product not found');

  try {
    const supabase = await getSupabase();

    // The joined course rows come from the cache, which may be empty before the
    // first Phase 5 sync. That must degrade to "no course detail" rather than a
    // 404 on a product that genuinely exists and is purchasable.
    const { data, error } = await supabase
      .from('products')
      .select(
        `id, name, slug, description, price_centavos, currency, thumbnail_url,
         product_courses ( moodle_course_id, courses ( fullname, shortname, summary ) )`,
      )
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle<Product & { product_courses: unknown[] }>();

    if (error) throw error;
    if (!data) return notFound('Product not found');

    return ok({ product: data });
  } catch (err) {
    return serverError('products.detail', err);
  }
}

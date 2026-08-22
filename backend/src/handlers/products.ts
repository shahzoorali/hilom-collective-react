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
    const products = data ?? [];

    // Card image = the lowest-numbered linked course's image (deterministic
    // for bundles, which link multiple courses). product_courses has no FK to
    // courses on purpose (see detail() below), so this is two queries, not an
    // embed.
    const productIds = products.map((p) => p.id);
    const { data: links, error: linksError } = await supabase
      .from('product_courses')
      .select('product_id, moodle_course_id')
      .in('product_id', productIds)
      .order('moodle_course_id', { ascending: true });
    if (linksError) console.warn('[products.list] product_courses lookup failed', linksError);

    const courseIds = [...new Set((links ?? []).map((l) => l.moodle_course_id as number))];
    const { data: courseImages, error: imagesError } = await supabase
      .from('courses')
      .select('moodle_course_id, image_url')
      .in('moodle_course_id', courseIds);
    if (imagesError) console.warn('[products.list] course image lookup failed', imagesError);

    const imageByCourseId = new Map((courseImages ?? []).map((c) => [c.moodle_course_id, c.image_url]));
    const firstImageByProductId = new Map<string, string | null>();
    const courseIdsByProductId = new Map<string, number[]>();
    for (const link of links ?? []) {
      if (!firstImageByProductId.has(link.product_id)) {
        firstImageByProductId.set(link.product_id, imageByCourseId.get(link.moodle_course_id) ?? null);
      }
      const ids = courseIdsByProductId.get(link.product_id) ?? [];
      ids.push(link.moodle_course_id);
      courseIdsByProductId.set(link.product_id, ids);
    }

    return ok({
      products: products.map((p) => ({
        ...p,
        image_url: firstImageByProductId.get(p.id) ?? null,
        moodle_course_ids: courseIdsByProductId.get(p.id) ?? [],
      })),
    });
  } catch (err) {
    return serverError('products.list', err);
  }
}

export async function detail(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const slug = event.pathParameters?.slug;
  if (!slug) return notFound('Product not found');

  try {
    const supabase = await getSupabase();

    const { data: product, error } = await supabase
      .from('products')
      .select(
        `id, name, slug, description, price_centavos, currency, thumbnail_url,
         product_courses ( moodle_course_id )`,
      )
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle<Product & { product_courses: { moodle_course_id: number }[] }>();

    if (error) throw error;
    if (!product) return notFound('Product not found');

    // Course metadata is fetched separately rather than as a nested embed:
    // product_courses has no foreign key to courses on purpose, so that an empty
    // or stale cache can never block a sale. PostgREST can only infer an embed
    // from a real FK, so asking for one here fails with "could not find a
    // relationship".
    const courseIds = product.product_courses.map((pc) => pc.moodle_course_id);
    const { data: courses, error: coursesError } = await supabase
      .from('courses')
      .select(
        'moodle_course_id, fullname, shortname, summary, content_html, image_url, enrolled_count, last_synced_at',
      )
      .in('moodle_course_id', courseIds)
      .order('moodle_course_id', { ascending: true });

    // A cache miss degrades to "no course detail" rather than failing the whole
    // product page — the product is still purchasable either way.
    if (coursesError) console.warn('[products.detail] course cache lookup failed', coursesError);

    return ok({
      product: {
        ...product,
        moodle_course_ids: courseIds,
        courses: courses ?? [],
      },
    });
  } catch (err) {
    return serverError('products.detail', err);
  }
}

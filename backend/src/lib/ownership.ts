/**
 * Which Moodle course ids a buyer already has permanent access to, derived
 * from their own fulfilled orders. Shared by checkout (block repurchase) and
 * the /me/owned-courses endpoint (ribbon/CTA on the storefront) so the two
 * can never disagree about what "already owns it" means.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function getOwnedCourseIds(
  supabase: SupabaseClient,
  buyerEmail: string,
): Promise<Set<number>> {
  const { data: ownedOrders } = await supabase
    .from('orders')
    .select('product_id')
    .eq('buyer_email', buyerEmail)
    .eq('status', 'fulfilled');
  const ownedProductIds = [...new Set((ownedOrders ?? []).map((r) => r.product_id as string))];
  if (ownedProductIds.length === 0) return new Set();

  const { data: ownedCourseRows } = await supabase
    .from('product_courses')
    .select('moodle_course_id')
    .in('product_id', ownedProductIds);

  return new Set((ownedCourseRows ?? []).map((r) => r.moodle_course_id as number));
}

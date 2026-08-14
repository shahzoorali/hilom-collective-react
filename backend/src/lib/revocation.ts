/**
 * Manual refund-revoke (Phase 8).
 *
 * The refund itself happens in the PayMongo dashboard — deliberately not
 * automated, per the locked decision. This only handles the consequence:
 * removing the course access that refunded order granted, and marking the order
 * `refunded` so the money record stays truthful.
 */
import { getSupabase } from './supabase.js';
import { getMoodleSecret } from './secrets.js';
import { MoodleClient } from './moodle.js';

export interface RevokeResult {
  orderId: string;
  status: 'refunded' | 'already_refunded';
  moodleUserId: number | null;
  revokedCourseIds: number[];
  /** Courses left alone because another live order still grants them. */
  retainedCourseIds: number[];
}

interface OrderRow {
  id: string;
  product_id: string;
  buyer_email: string;
  status: string;
  moodle_user_id: number | null;
}

export async function revokeOrderAccess(orderId: string): Promise<RevokeResult> {
  const supabase = await getSupabase();

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, product_id, buyer_email, status, moodle_user_id')
    .eq('id', orderId)
    .maybeSingle<OrderRow>();

  if (error) throw error;
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (order.status === 'refunded') {
    return {
      orderId,
      status: 'already_refunded',
      moodleUserId: order.moodle_user_id,
      revokedCourseIds: [],
      retainedCourseIds: [],
    };
  }

  const { data: ownCourses, error: ownErr } = await supabase
    .from('product_courses')
    .select('moodle_course_id')
    .eq('product_id', order.product_id);
  if (ownErr) throw ownErr;
  const candidateIds = (ownCourses ?? []).map((r) => r.moodle_course_id as number);

  /*
   * Do NOT blindly unenrol every course this product granted.
   *
   * A buyer can hold overlapping products — e.g. "Module 1" bought on its own
   * AND "The Breakthrough Bundle", which also grants Module 1. Refunding one of
   * them must not remove access the other one still legitimately pays for.
   * So: subtract every course still granted by this buyer's other orders that
   * are fulfilled and not refunded.
   */
  const { data: otherOrders, error: otherErr } = await supabase
    .from('orders')
    .select('product_id')
    .eq('buyer_email', order.buyer_email)
    .eq('status', 'fulfilled')
    .neq('id', orderId);
  if (otherErr) throw otherErr;

  const otherProductIds = [...new Set((otherOrders ?? []).map((o) => o.product_id as string))];

  let stillGranted = new Set<number>();
  if (otherProductIds.length > 0) {
    const { data: keepRows, error: keepErr } = await supabase
      .from('product_courses')
      .select('moodle_course_id')
      .in('product_id', otherProductIds);
    if (keepErr) throw keepErr;
    stillGranted = new Set((keepRows ?? []).map((r) => r.moodle_course_id as number));
  }

  const toRevoke = candidateIds.filter((id) => !stillGranted.has(id));
  const retained = candidateIds.filter((id) => stillGranted.has(id));

  if (order.moodle_user_id && toRevoke.length > 0) {
    const { token, url } = await getMoodleSecret();
    const moodle = new MoodleClient(token, url);
    await moodle.unenrolUser(order.moodle_user_id, toRevoke);
  }

  // The order is marked refunded even when nothing needed unenrolling (an order
  // that never reached `fulfilled`, or one whose courses are all still covered)
  // — the money record has to reflect the refund either way.
  const { error: updateErr } = await supabase
    .from('orders')
    .update({ status: 'refunded' })
    .eq('id', orderId);
  if (updateErr) throw updateErr;

  return {
    orderId,
    status: 'refunded',
    moodleUserId: order.moodle_user_id,
    revokedCourseIds: toRevoke,
    retainedCourseIds: retained,
  };
}

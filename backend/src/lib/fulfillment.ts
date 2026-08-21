/**
 * Core fulfillment logic: given an order that is `paid_pending_enrollment`,
 * ensure the buyer has both a Cognito identity and a Moodle account, then
 * enroll them in every course the purchased product grants.
 *
 * Deliberately shared by three callers — the webhook handler (first attempt),
 * the SQS retry consumer, and the admin manual-retry endpoint — so all three
 * paths behave identically. A bundle is not a special case here: the course
 * list just happens to have more than one row.
 */
import { getSupabase } from './supabase.js';
import { getMoodleSecret } from './secrets.js';
import { MoodleClient } from './moodle.js';
import { ensureCognitoUser } from './cognito.js';
import { sendEnrollmentEmail } from './enrollment-email.js';
import { accessUrl } from './access-url.js';

export interface FulfillResult {
  orderId: string;
  status: 'fulfilled' | 'already_fulfilled';
  moodleUserId: number;
  cognitoUserSub: string;
  courseIds: number[];
}

interface OrderRow {
  id: string;
  product_id: string;
  buyer_email: string;
  status: string;
}

interface ProductRow {
  name: string;
}

function splitName(email: string, name?: string | null): { firstname: string; lastname: string } {
  const trimmed = name?.trim();
  if (!trimmed) return { firstname: email.split('@')[0] ?? 'Buyer', lastname: '' };
  const [first, ...rest] = trimmed.split(/\s+/);
  return { firstname: first ?? trimmed, lastname: rest.join(' ') };
}

export async function fulfillOrder(orderId: string, billingName?: string | null): Promise<FulfillResult> {
  const supabase = await getSupabase();

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, product_id, buyer_email, status')
    .eq('id', orderId)
    .single<OrderRow>();

  if (orderError) throw orderError;
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (order.status === 'fulfilled') {
    // Idempotent stop — a retry (webhook redelivery, SQS redrive, admin click)
    // on an already-fulfilled order is a no-op, not an error.
    const { data: existing } = await supabase
      .from('orders')
      .select('cognito_user_sub, moodle_user_id')
      .eq('id', orderId)
      .single();
    return {
      orderId,
      status: 'already_fulfilled',
      moodleUserId: existing?.moodle_user_id ?? 0,
      cognitoUserSub: existing?.cognito_user_sub ?? '',
      courseIds: [],
    };
  }

  const { firstname, lastname } = splitName(order.buyer_email, billingName);

  // Everything from here down is wrapped in one try/catch: a failure at ANY
  // step — including the course lookup, which used to happen outside this
  // block — must record error_detail. That gap was found in production
  // testing: a broken product/course mapping failed with a 500 and the order
  // stayed silently unrecorded, which is exactly the "paid but no visible
  // reason why" state the plan requires never happens.
  try {
    const { data: productCourses, error: coursesError } = await supabase
      .from('product_courses')
      .select('moodle_course_id')
      .eq('product_id', order.product_id);

    if (coursesError) throw coursesError;
    const courseIds = (productCourses ?? []).map((r) => r.moodle_course_id as number);
    if (courseIds.length === 0) {
      throw new Error(`Product ${order.product_id} has no mapped Moodle courses — check product_courses`);
    }

    const cognitoUserSub = await ensureCognitoUser(order.buyer_email, firstname, lastname);

    const { token, url } = await getMoodleSecret();
    const moodle = new MoodleClient(token, url);

    let moodleUser = await moodle.getUserByEmail(order.buyer_email);
    if (!moodleUser) {
      try {
        // auth: 'oauth2' — this account is meant to be reached via Cognito
        // SSO, it has no local Moodle password to guess.
        await moodle.createUser({
          username: order.buyer_email.toLowerCase(),
          email: order.buyer_email,
          firstname,
          lastname: lastname || firstname,
        });
      } catch (createErr) {
        // Observed in production testing: a create call can fail on our end
        // (timeout, deadlock, or Moodle's own user-cache briefly returning a
        // stale "not found" right after a concurrent write commits) while the
        // row still exists or lands moments later. Before giving up, check
        // again rather than assuming the error means nothing happened —
        // exactly the same lesson Phase 2 hit with "MySQL server has gone
        // away". A retry naively re-calling createUser here would otherwise
        // hard-fail forever on a duplicate-key error.
        const recheck = await moodle.getUserByEmail(order.buyer_email);
        if (!recheck) throw createErr;
        moodleUser = recheck;
      }
      if (!moodleUser) {
        moodleUser = await moodle.getUserByEmail(order.buyer_email);
      }
      if (!moodleUser) {
        throw new Error(`Moodle user ${order.buyer_email} still not found after creation`);
      }
    }

    // Verified idempotent against production — safe to call again on retry
    // without checking existing enrollments first.
    await moodle.enrolUser(moodleUser.id, courseIds);

    const { error: updateError } = await supabase
      .from('orders')
      .update({
        status: 'fulfilled',
        cognito_user_sub: cognitoUserSub,
        moodle_user_id: moodleUser.id,
        error_detail: null,
      })
      .eq('id', orderId);
    if (updateError) throw updateError;

    // Best-effort, and deliberately after the order is already durably marked
    // `fulfilled`: the buyer's course access is real either way, and an SES
    // hiccup (the ap-southeast-1 identity is still sandboxed as of writing)
    // must not turn a successful enrollment into a retried/failed order.
    const { data: product } = await supabase
      .from('products')
      .select('name')
      .eq('id', order.product_id)
      .single<ProductRow>();
    await sendEnrollmentEmail({
      buyerEmail: order.buyer_email,
      productName: product?.name ?? 'your course',
      accessUrl: accessUrl(courseIds),
    });

    return { orderId, status: 'fulfilled', moodleUserId: moodleUser.id, cognitoUserSub, courseIds };
  } catch (err) {
    // Money stays recorded regardless — only error_detail changes. status
    // stays paid_pending_enrollment so the order remains visible as
    // recoverable rather than silently lost.
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('orders').update({ error_detail: message }).eq('id', orderId);
    throw err;
  }
}

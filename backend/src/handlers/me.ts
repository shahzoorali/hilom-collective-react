/**
 * GET /me/owned-courses
 *
 * Powers the "already own it" ribbon/CTA on the course catalog and product
 * pages — the storefront's chance to steer a signed-in buyer away from
 * checkout before they get there, rather than relying solely on the block in
 * checkout.createSession.
 *
 * Auth-only like checkout: identity comes from the verified id_token, never
 * from a query param, for the same reason checkout does it that way — a
 * caller must not be able to ask "does someone else own this?" by naming an
 * arbitrary email.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, serverError, unauthorized } from '../lib/http.js';
import { requireBuyer, UnauthorizedError } from '../lib/auth.js';
import { getOwnedCourseIds } from '../lib/ownership.js';

export async function ownedCourses(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let buyer;
  try {
    buyer = await requireBuyer(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('me.ownedCourses', err);
  }

  try {
    const supabase = await getSupabase();
    const courseIds = await getOwnedCourseIds(supabase, buyer.email);
    return ok({ courseIds: [...courseIds] });
  } catch (err) {
    return serverError('me.ownedCourses', err);
  }
}

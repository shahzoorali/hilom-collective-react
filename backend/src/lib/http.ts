/**
 * Shared HTTP helpers for API Gateway HTTP API (payload format 2.0).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSecret } from './secrets.js';
import { requireUser } from './auth.js';

/**
 * CORS is also configured on the HTTP API itself. It is repeated here because
 * API Gateway does not attach its CORS headers to responses produced by Lambda
 * error paths in every case, and a checkout failing with an opaque CORS error
 * instead of a real message is a bad thing to debug in production.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? '*',
  'Content-Type': 'application/json',
} as const;

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}

export const ok = (body: unknown) => json(200, body);
export const notFound = (message = 'Not found') => json(404, { error: message });
export const badRequest = (message: string) => json(400, { error: message });
export const unauthorized = (message = 'Unauthorized') => json(401, { error: message });

/**
 * Logs the real error server-side but returns a generic message. Internal detail
 * (Supabase errors, Moodle debuginfo) must not reach the browser.
 */
export function serverError(context: string, err: unknown): APIGatewayProxyResultV2 {
  console.error(`[${context}]`, err);
  return json(500, { error: 'Internal server error' });
}

/**
 * Admin endpoints are protected by a shared key until Phase 7 puts them behind a
 * Cognito admin group.
 *
 * The key is read from Secrets Manager rather than a Lambda environment
 * variable: env vars are visible to anyone with console read access to the
 * function, which is a wider audience than should hold an admin credential.
 *
 * Comparison is constant-time to avoid leaking the key through response timing.
 */
export async function isAuthorizedAdmin(
  headers: Record<string, string | undefined>,
): Promise<boolean> {
  // API Gateway v2 lower-cases header names, but be tolerant of direct invokes.
  const provided = headers['x-admin-key'] ?? headers['X-Admin-Key'];
  if (!provided) return false;

  const { key: expected } = await getSecret<{ key: string }>(
    process.env.ADMIN_KEY_SECRET_ID ?? 'hilom/admin-api-key',
  );
  if (!expected) return false;

  // Length is compared first and short-circuits; that leaks only the key's
  // length, which is fixed and not secret.
  if (provided.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Admin authorization for endpoints added from the facilitator marketplace on.
 *
 * Accepts either credential:
 *   * a Cognito id_token whose `cognito:groups` contains `admin` — the real
 *     model, where an action is attributable to a person; or
 *   * the legacy `x-admin-key` shared secret.
 *
 * Both are accepted rather than cutting over because the existing admin tabs
 * (pages, posts, events, media, menus, forms, commerce) all send the key from
 * sessionStorage, and swapping their auth out is a separate, riskier change
 * than adding new screens. New endpoints should use this; migrating the old
 * ones is follow-up work, at which point the key branch can be deleted.
 *
 * The group is checked first so a request carrying both credentials is
 * attributed to the person rather than to the shared secret.
 */
export async function isAdminCaller(event: APIGatewayProxyEventV2): Promise<boolean> {
  try {
    const user = await requireUser(event);
    if (user.groups.includes('admin')) return true;
  } catch {
    // No token, or not a valid one — fall through to the shared key. This is
    // not an error path: most current admin traffic carries no Authorization
    // header at all.
  }

  return isAuthorizedAdmin(event.headers ?? {});
}

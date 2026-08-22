/**
 * Public runtime configuration.
 *
 * Everything here ships inside the JS bundle and is therefore public by
 * definition. Only values that are safe to expose belong in this file — the
 * Cognito client here is a *public* client with no secret (PKCE), and the
 * PayMongo public key is fetched from the backend per checkout rather than
 * hardcoded. No secret key, no Supabase secret key, ever.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api.hilomcollective.com';

export const COGNITO = {
  domain: 'hilom-auth.auth.ap-southeast-1.amazoncognito.com',
  // Public SPA client — deliberately separate from the `hilom-moodle` client,
  // which has a secret and must never be used from a browser.
  clientId: '29bo0gpj7j9u7ofbcii22emj8l',
  scopes: 'openid email profile',
} as const;

export const MOODLE_URL = 'https://www.learn.hilomcollective.com';

/**
 * Mirrors backend/src/lib/access-url.ts: a single owned course deep-links
 * straight to it, a bundle (or multiple owned courses) has no one "right"
 * course to land on, so it goes to the dashboard.
 */
export function moodleAccessUrl(courseIds: number[]): string {
  if (courseIds.length === 1) return `${MOODLE_URL}/course/view.php?id=${courseIds[0]}`;
  return `${MOODLE_URL}/my/`;
}

export const redirectUri = () => `${window.location.origin}/auth/callback`;

/**
 * Cognito Hosted UI login using the authorization-code flow with PKCE.
 *
 * Implemented directly rather than pulling in Amplify: this is the entire
 * surface we need, and PKCE exists precisely so a browser app can do the code
 * exchange without holding a client secret.
 *
 * Tokens live in sessionStorage, not localStorage — they are cleared when the
 * tab closes, which limits the window in which a stolen token is useful. They
 * are never sent anywhere except Cognito.
 */
import { COGNITO, redirectUri } from '../config';

const VERIFIER_KEY = 'hilom.pkce.verifier';
const TOKENS_KEY = 'hilom.tokens';

export interface HilomUser {
  email: string;
  givenName?: string;
  familyName?: string;
}

interface StoredTokens {
  idToken: string;
  accessToken: string;
  expiresAt: number;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Sends the browser to Cognito's Hosted UI. */
export async function login(returnTo?: string): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  if (returnTo) sessionStorage.setItem('hilom.returnTo', returnTo);

  const challenge = base64url(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: COGNITO.clientId,
    response_type: 'code',
    scope: COGNITO.scopes,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `https://${COGNITO.domain}/oauth2/authorize?${params}`;
}

/** Completes the code exchange on /auth/callback. Returns where to go next. */
export async function handleCallback(code: string): Promise<string> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Missing PKCE verifier — start the login again.');

  const res = await fetch(`https://${COGNITO.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COGNITO.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });

  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as { id_token: string; access_token: string; expires_in: number };

  const tokens: StoredTokens = {
    idToken: json.id_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  sessionStorage.removeItem(VERIFIER_KEY);

  const returnTo = sessionStorage.getItem('hilom.returnTo') ?? '/';
  sessionStorage.removeItem('hilom.returnTo');
  return returnTo;
}

/**
 * Reads the signed-in user out of the stored id_token.
 *
 * The claims are trusted only for *display*. Nothing security-sensitive is
 * decided here — the backend validates tokens itself for anything that matters.
 */
export function currentUser(): HilomUser | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;

  try {
    const tokens = JSON.parse(raw) as StoredTokens;
    if (Date.now() >= tokens.expiresAt) {
      sessionStorage.removeItem(TOKENS_KEY);
      return null;
    }
    const payload = JSON.parse(atob(tokens.idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: string;
      given_name?: string;
      family_name?: string;
    };
    if (!payload.email) return null;
    return { email: payload.email, givenName: payload.given_name, familyName: payload.family_name };
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

export function logout(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  const params = new URLSearchParams({
    client_id: COGNITO.clientId,
    logout_uri: `${window.location.origin}/`,
  });
  window.location.href = `https://${COGNITO.domain}/logout?${params}`;
}

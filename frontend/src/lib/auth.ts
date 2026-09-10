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

/**
 * A name the user has just changed, held over the top of the id_token claim.
 *
 * There is no refresh-token flow here (see the file header — the SPA holds only
 * what the code exchange returned), so a rename lands in Cognito but the token
 * in this tab keeps the old `given_name` until the next sign-in. Without this
 * override, saving your name appears to do nothing: the form reports success
 * and the page immediately re-renders the stale claim.
 *
 * Cleared by `logout`, and stored beside the tokens in sessionStorage so it
 * dies with the tab like they do. Display only, exactly like the claims it
 * shadows — Cognito holds the real value.
 */
const NAME_OVERRIDE_KEY = 'hilom.nameOverride';

export interface HilomUser {
  email: string;
  givenName?: string;
  familyName?: string;
  /**
   * Cognito group memberships from the `cognito:groups` claim — `facilitator`,
   * `admin`, or neither for an ordinary buyer.
   *
   * Used only to decide what to *render* (whether to show the facilitator
   * dashboard link, which tabs to draw). Every endpoint behind those screens
   * re-checks the group on the verified token server-side, so editing this
   * array in devtools buys nothing but a broken-looking page.
   */
  groups: string[];
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
      'cognito:groups'?: string[];
    };
    if (!payload.email) return null;
    const override = readNameOverride();
    return {
      email: payload.email,
      givenName: override?.givenName ?? payload.given_name,
      familyName: override?.familyName ?? payload.family_name,
      // Absent, not empty, for a user in no groups — which is every buyer.
      groups: Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [],
    };
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

/**
 * The raw id_token, for sending to our own API as a bearer credential.
 *
 * The id token rather than the access token because the backend needs the
 * `email` claim, which Cognito puts only on the id token. Returns null once
 * expired, so a caller gets a clean "signed out" rather than a 401 round trip.
 */
export function idToken(): string | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as StoredTokens;
    if (Date.now() >= tokens.expiresAt) {
      sessionStorage.removeItem(TOKENS_KEY);
      return null;
    }
    return tokens.idToken;
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

function readNameOverride(): { givenName: string; familyName: string } | null {
  const raw = sessionStorage.getItem(NAME_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { givenName: string; familyName: string };
  } catch {
    sessionStorage.removeItem(NAME_OVERRIDE_KEY);
    return null;
  }
}

/** Records a just-saved name so `currentUser()` stops returning the stale claim. */
export function setNameOverride(givenName: string, familyName: string): void {
  sessionStorage.setItem(NAME_OVERRIDE_KEY, JSON.stringify({ givenName, familyName }));
}

export function logout(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  sessionStorage.removeItem(NAME_OVERRIDE_KEY);
  const params = new URLSearchParams({
    client_id: COGNITO.clientId,
    logout_uri: `${window.location.origin}/`,
  });
  window.location.href = `https://${COGNITO.domain}/logout?${params}`;
}

/**
 * Whether the signed-in user holds a Cognito group. Display-level only — see
 * the note on `HilomUser.groups`.
 */
export function hasGroup(group: string): boolean {
  return currentUser()?.groups.includes(group) ?? false;
}

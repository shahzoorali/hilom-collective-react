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
 *
 * The id/access tokens Cognito issues are good for one hour. The refresh token
 * that comes back with them is good for thirty days, and `startSessionKeepAlive`
 * spends it a few minutes before each expiry so a tab that is merely *open* —
 * a facilitator with the dashboard up while they work — never silently drops
 * to signed-out mid-session. The refresh token itself still dies with the tab.
 */
import { COGNITO, redirectUri } from '../config';

const VERIFIER_KEY = 'hilom.pkce.verifier';
const TOKENS_KEY = 'hilom.tokens';

/**
 * A name the user has just changed, held over the top of the id_token claim.
 *
 * A refresh reissues the id_token from Cognito's *current* user record, so the
 * new name does arrive eventually — but a rename lands in Cognito immediately
 * and the token in this tab keeps the old `given_name` until then. Without this
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
  /** Absent for a session established before refresh was implemented. */
  refreshToken?: string;
  expiresAt: number;
}

/**
 * How long before expiry a refresh is worth doing.
 *
 * Generous on purpose: `idToken()` is synchronous and has a dozen call sites,
 * so the guarantee this module makes is that the *stored* token is kept fresh
 * ahead of time rather than renewed at the moment of use. Five minutes covers
 * a slow refresh, a throttled background timer and the clock skew between the
 * browser and Cognito all at once.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Fired whenever the stored session appears or disappears, so the UI can re-read it. */
export const AUTH_EVENT = 'hilom:auth';

function readTokens(): StoredTokens | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

function writeTokens(tokens: StoredTokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  window.dispatchEvent(new Event(AUTH_EVENT));
}

function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  sessionStorage.removeItem(NAME_OVERRIDE_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
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
  const json = (await res.json()) as TokenResponse;

  writeTokens({
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  sessionStorage.removeItem(VERIFIER_KEY);
  scheduleRefresh();

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
  const tokens = readTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expiresAt) {
    clearTokens();
    return null;
  }

  try {
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
    clearTokens();
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
  const tokens = readTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expiresAt) {
    clearTokens();
    return null;
  }
  // Belt and braces: the keep-alive timer normally gets here first, but a tab
  // whose timers were throttled while backgrounded can come back with minutes
  // left on the clock. This kicks off the renewal without blocking the caller,
  // who still has a valid token to send right now.
  if (tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) void ensureFreshSession();
  return tokens.idToken;
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
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  clearTokens();
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

// ---------------------------------------------------------------------------
// Keeping the session alive
// ---------------------------------------------------------------------------

interface TokenResponse {
  id_token: string;
  access_token: string;
  /** Only the authorization-code exchange returns one; a refresh reuses it. */
  refresh_token?: string;
  expires_in: number;
}

let refreshTimer: number | null = null;
/** The one in-flight refresh, shared so a burst of API calls makes one request. */
let inFlight: Promise<boolean> | null = null;

/**
 * Trades the refresh token for a fresh id/access pair.
 *
 * Returns false when there is nothing to renew or the refresh token is no
 * longer good — the second case is a real end of session (revoked, thirty days
 * elapsed, password changed) and clears the tab so the UI stops pretending
 * someone is signed in.
 *
 * A network failure is deliberately *not* treated that way: the token we hold
 * is still valid for a few more minutes, and signing someone out because their
 * wifi blinked is the exact bug this whole file is here to stop.
 */
async function refreshSession(): Promise<boolean> {
  const tokens = readTokens();
  if (!tokens?.refreshToken) return false;

  let res: Response;
  try {
    res = await fetch(`https://${COGNITO.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: COGNITO.clientId,
        refresh_token: tokens.refreshToken,
      }),
    });
  } catch {
    return false;
  }

  if (!res.ok) {
    // 400 invalid_grant is Cognito saying the refresh token is dead. Anything
    // else (429, 5xx) is transient and the next scheduled attempt can retry.
    if (res.status === 400 || res.status === 401) clearTokens();
    return false;
  }

  const json = (await res.json()) as TokenResponse;
  writeTokens({
    idToken: json.id_token,
    accessToken: json.access_token,
    // Cognito omits the refresh token on a refresh — keep the one we have, or
    // the *next* renewal has nothing to spend.
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  return true;
}

/**
 * Renews the session if it is close to expiring, coalescing concurrent callers.
 *
 * Resolves true only when a refresh actually happened, which is what tells
 * `apiFetch` a retry is worth attempting.
 */
export function ensureFreshSession(): Promise<boolean> {
  const tokens = readTokens();
  if (!tokens?.refreshToken) return Promise.resolve(false);
  if (tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) return Promise.resolve(false);
  if (inFlight) return inFlight;

  inFlight = refreshSession().finally(() => {
    inFlight = null;
    scheduleRefresh();
  });
  return inFlight;
}

/** Arms a single timer for the next renewal, replacing any already pending. */
function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;

  const tokens = readTokens();
  if (!tokens?.refreshToken) return;

  // Floored rather than clamped at zero: a due-now renewal that just failed
  // transiently would otherwise respin the timer instantly and hammer Cognito.
  const delay = Math.max(30_000, tokens.expiresAt - Date.now() - REFRESH_SKEW_MS);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void ensureFreshSession();
  }, delay);
}

/**
 * Starts keeping the tab signed in. Called once, from the app entry point.
 *
 * The timer alone is not enough. Browsers throttle (and on mobile, suspend)
 * timers in a backgrounded tab, which is precisely the "I left it for a while
 * and came back signed out" case that was reported — so returning to the tab,
 * or the network coming back, also triggers a check.
 */
export function startSessionKeepAlive(): void {
  scheduleRefresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void ensureFreshSession();
  });
  window.addEventListener('focus', () => void ensureFreshSession());
  window.addEventListener('online', () => void ensureFreshSession());
}

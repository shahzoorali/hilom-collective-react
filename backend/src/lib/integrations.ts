/**
 * The shared OAuth layer behind connected meeting accounts.
 *
 * Provider-agnostic on purpose: everything here is "connect an account, keep
 * the tokens alive, hand me a working access token". What is *done* with that
 * token — create a Meet space, schedule a Zoom meeting — lives with each
 * provider and is deliberately not in this file. See
 * docs/meeting-link-integrations.md.
 *
 * The two facts that shape this module:
 *
 *  1. **Zoom rotates its refresh token on every use.** Each refresh returns a
 *     new one and invalidates the old. Persisting it is not bookkeeping — miss
 *     it once and that facilitator is locked out permanently, with no way back
 *     but reconnecting by hand. Every write path below treats the new refresh
 *     token as the thing that must survive.
 *
 *  2. **A dead connection must be discovered before a client books, not when
 *     they are waiting on a call.** So a permanent refresh failure is recorded
 *     on the row (`broken_at`) rather than thrown away as a transient error,
 *     and transient failures are carefully *not* recorded as permanent.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSecret } from './secrets.js';
import { decryptToken, encryptToken, fromBytea, toBytea } from './token-crypto.js';

export type Provider = 'google_meet' | 'zoom';

export const PROVIDERS: Provider[] = ['google_meet', 'zoom'];

export const isProvider = (value: unknown): value is Provider =>
  typeof value === 'string' && (PROVIDERS as string[]).includes(value);

/** Thrown for anything the caller should see as a 4xx. */
export class IntegrationError extends Error {}

interface OAuthSecret {
  clientId: string;
  clientSecret: string;
}

interface Identity {
  accountId: string | null;
  email: string | null;
}

interface ProviderConfig {
  label: string;
  secretId: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  scopes: string[];
  /** Extra params on the authorize redirect. */
  authorizeExtras: Record<string, string>;
  /**
   * How the token endpoint wants to be authenticated. Zoom requires HTTP Basic
   * with the client credentials; Google takes them in the form body. Sending
   * the wrong one is a 401 with an unhelpful message.
   */
  tokenAuth: 'basic' | 'body';
  identify(accessToken: string, tokenResponse: TokenResponse): Promise<Identity>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/**
 * Decodes a JWT payload without verifying it.
 *
 * Safe *only* here: this id_token came straight from Google's token endpoint
 * over TLS in response to our own authenticated request, which is the one case
 * the OpenID spec allows skipping signature validation. It must never be used
 * on a token that arrived from a browser.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

const CONFIG: Record<Provider, ProviderConfig> = {
  google_meet: {
    label: 'Google Meet',
    secretId: 'hilom/google-meet',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // `meetings.space.created` is principal-scoped: it reaches only the spaces
    // this app itself creates, never their calendar or existing meetings.
    // `openid email` is non-sensitive and is what lets the dashboard say which
    // account is connected instead of showing an anonymous green tick.
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/meetings.space.created'],
    authorizeExtras: {
      // Google only issues a refresh token when both are present, and only on
      // the *first* consent unless prompt=consent forces it. Without these a
      // reconnect silently yields an access-token-only grant that dies in an
      // hour and cannot be refreshed.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
    tokenAuth: 'body',
    identify: async (_accessToken, tokens) => {
      const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
      return {
        accountId: typeof claims.sub === 'string' ? claims.sub : null,
        email: typeof claims.email === 'string' ? claims.email : null,
      };
    },
  },

  zoom: {
    label: 'Zoom',
    secretId: 'hilom/zoom',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    revokeUrl: 'https://zoom.us/oauth/revoke',
    // Zoom's granular scopes. These must match exactly what the Marketplace app
    // is configured to request — a mismatch is rejected at the consent screen,
    // so treat this list and the app's scope list as one thing kept in sync.
    scopes: [
      'meeting:write:meeting',
      'meeting:update:meeting',
      'meeting:delete:meeting',
      'user:read:user',
    ],
    authorizeExtras: {},
    tokenAuth: 'basic',
    identify: async (accessToken) => {
      const res = await fetch('https://api.zoom.us/v2/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return { accountId: null, email: null };
      const user = (await res.json()) as { id?: string; email?: string };
      return { accountId: user.id ?? null, email: user.email ?? null };
    },
  },
};

export const providerLabel = (provider: Provider): string => CONFIG[provider].label;

const redirectUri = (provider: Provider): string => {
  const base = process.env.API_BASE_URL ?? 'https://api.hilomcollective.com';
  return `${base}/facilitator/integrations/${provider}/callback`;
};

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------
// `state` proves the callback belongs to a flow we started; PKCE proves it
// belongs to *this* client. Both providers support it, and it closes the
// authorization-code interception window that state alone leaves open.

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const makeVerifier = (): string => base64url(randomBytes(48));

const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest());

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/**
 * Begins a connect flow: records a one-time state row and returns the URL the
 * browser should be sent to.
 */
export async function startConnect(
  supabase: SupabaseClient,
  facilitatorId: string,
  provider: Provider,
  returnTo: string | null,
): Promise<{ authorizeUrl: string }> {
  const config = CONFIG[provider];
  const { clientId } = await getSecret<OAuthSecret>(config.secretId);

  const state = `${randomUUID()}.${base64url(randomBytes(16))}`;
  const codeVerifier = makeVerifier();

  const { error } = await supabase.from('facilitator_oauth_states').insert({
    state,
    facilitator_id: facilitatorId,
    provider,
    code_verifier: codeVerifier,
    return_to: returnTo,
  });
  if (error) throw error;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(provider),
    scope: config.scopes.join(' '),
    state,
    code_challenge: challengeFor(codeVerifier),
    code_challenge_method: 'S256',
    ...config.authorizeExtras,
  });

  return { authorizeUrl: `${config.authorizeUrl}?${params.toString()}` };
}

/** Exchanges an authorization code or a refresh token for a token set. */
async function requestTokens(
  provider: Provider,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const config = CONFIG[provider];
  const { clientId, clientSecret } = await getSecret<OAuthSecret>(config.secretId);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const form = new URLSearchParams(body);

  if (config.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  }

  const res = await fetch(config.tokenUrl, { method: 'POST', headers, body: form });
  const text = await res.text();

  if (!res.ok) {
    // The provider's own error code is preserved so callers can tell
    // `invalid_grant` (permanent — the user revoked us) from a 503 (retry).
    // Never log `text` wholesale: a token endpoint's error body can echo the
    // request, and the request contains a client secret.
    let code = 'unknown_error';
    try {
      code = String((JSON.parse(text) as { error?: string }).error ?? code);
    } catch {
      /* non-JSON error body; the code stays unknown */
    }
    throw new OAuthTokenError(code, res.status);
  }

  return JSON.parse(text) as TokenResponse;
}

export class OAuthTokenError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Token endpoint returned ${status} (${code})`);
    this.name = 'OAuthTokenError';
  }

  /**
   * Whether this means "reconnect required" rather than "try again later".
   *
   * Getting this wrong in either direction is bad: treating a transient 503 as
   * permanent tells a facilitator their working connection is broken, and
   * treating a revoked grant as transient means retrying forever and never
   * telling them.
   */
  get isPermanent(): boolean {
    return (
      this.code === 'invalid_grant' ||
      this.code === 'invalid_client' ||
      this.code === 'unauthorized_client' ||
      this.status === 400 ||
      this.status === 401
    );
  }
}

const expiryFrom = (expiresIn: number | undefined): string =>
  new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();

/**
 * Completes a connect flow.
 *
 * The state row is claimed with a delete-and-return, so a replayed callback
 * finds nothing and fails — one-time use without a lock.
 */
export async function completeConnect(
  supabase: SupabaseClient,
  state: string,
  code: string,
): Promise<{ facilitatorId: string; provider: Provider; returnTo: string | null }> {
  const { data: claimed, error: claimError } = await supabase
    .from('facilitator_oauth_states')
    .delete()
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .select('facilitator_id, provider, code_verifier, return_to')
    .maybeSingle<{
      facilitator_id: string;
      provider: Provider;
      code_verifier: string;
      return_to: string | null;
    }>();

  if (claimError) throw claimError;
  if (!claimed) throw new IntegrationError('That connection link has expired — please try again.');

  const provider = claimed.provider;
  const tokens = await requestTokens(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(provider),
    code_verifier: claimed.code_verifier,
  });

  if (!tokens.refresh_token) {
    // Google does this when a prior grant is still live and prompt=consent was
    // not honoured. Without a refresh token the connection dies in an hour, so
    // it is better to refuse it now than to store something that will fail
    // silently in the middle of someone's booking.
    throw new IntegrationError(
      `${CONFIG[provider].label} did not return a refresh token. Remove Hilom from your ${CONFIG[provider].label} account's connected apps and try again.`,
    );
  }

  const identity = await CONFIG[provider].identify(tokens.access_token, tokens).catch(() => ({
    // Identity is a nicety for the dashboard, not a requirement. A provider
    // hiccup here must not cost the facilitator the whole connection.
    accountId: null,
    email: null,
  }));

  const ctx = { facilitatorId: claimed.facilitator_id, provider };
  const [accessEnc, refreshEnc] = await Promise.all([
    encryptToken(tokens.access_token, ctx),
    encryptToken(tokens.refresh_token, ctx),
  ]);

  const { error } = await supabase.from('facilitator_integrations').upsert(
    {
      facilitator_id: claimed.facilitator_id,
      provider,
      access_token_enc: toBytea(accessEnc),
      refresh_token_enc: toBytea(refreshEnc),
      expires_at: expiryFrom(tokens.expires_in),
      external_account_id: identity.accountId,
      external_email: identity.email,
      scopes: tokens.scope ? tokens.scope.split(' ') : CONFIG[provider].scopes,
      // A reconnect is the documented fix for a broken connection, so it has to
      // actually clear the broken flag.
      broken_at: null,
      broken_reason: null,
      connected_at: new Date().toISOString(),
      last_refreshed_at: null,
    },
    { onConflict: 'facilitator_id,provider' },
  );
  if (error) throw error;

  return { facilitatorId: claimed.facilitator_id, provider, returnTo: claimed.return_to };
}

// ---------------------------------------------------------------------------
// Using a connection
// ---------------------------------------------------------------------------

interface IntegrationRow {
  id: string;
  facilitator_id: string;
  provider: Provider;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  broken_at: string | null;
  updated_at: string;
}

const ROW_COLUMNS =
  'id, facilitator_id, provider, access_token_enc, refresh_token_enc, expires_at, broken_at, updated_at';

/** Refresh this far before actual expiry, so a long request cannot straddle it. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Returns a usable access token for this facilitator and provider, refreshing
 * if needed. Throws `IntegrationError` if there is no healthy connection.
 *
 * This is the only sanctioned way to reach a token. Nothing else should decrypt
 * the column directly, because everything below — the skew, the rotation, the
 * broken-flag handling, the concurrent-refresh loss check — has to happen every
 * time or not at all.
 */
export async function getAccessToken(
  supabase: SupabaseClient,
  facilitatorId: string,
  provider: Provider,
): Promise<string> {
  const { data: row, error } = await supabase
    .from('facilitator_integrations')
    .select(ROW_COLUMNS)
    .eq('facilitator_id', facilitatorId)
    .eq('provider', provider)
    .maybeSingle<IntegrationRow>();

  if (error) throw error;
  if (!row) throw new IntegrationError(`No ${CONFIG[provider].label} account is connected.`);
  if (row.broken_at) {
    throw new IntegrationError(
      `The ${CONFIG[provider].label} connection needs reconnecting.`,
    );
  }

  const ctx = { facilitatorId, provider };
  const stillValid = new Date(row.expires_at).getTime() - REFRESH_SKEW_MS > Date.now();
  if (stillValid) return decryptToken(fromBytea(row.access_token_enc), ctx);

  return refresh(supabase, row, ctx);
}

async function refresh(
  supabase: SupabaseClient,
  row: IntegrationRow,
  ctx: { facilitatorId: string; provider: Provider },
): Promise<string> {
  const refreshToken = await decryptToken(fromBytea(row.refresh_token_enc), ctx);

  let tokens: TokenResponse;
  try {
    tokens = await requestTokens(ctx.provider, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch (err) {
    if (err instanceof OAuthTokenError && err.isPermanent) {
      await markBroken(supabase, row.id, err.code);
      throw new IntegrationError(
        `The ${CONFIG[ctx.provider].label} connection was revoked or expired. Please reconnect it.`,
      );
    }
    // Transient. Left healthy on purpose so the next attempt retries rather
    // than the facilitator being told to reconnect a working account.
    throw err;
  }

  // Zoom returns a *new* refresh token here and invalidates the one just used.
  // Google usually omits the field, meaning "keep the one you have". Falling
  // back to the old value covers Google; persisting the new one covers Zoom.
  // Getting this backwards locks Zoom facilitators out permanently.
  const nextRefresh = tokens.refresh_token ?? refreshToken;

  const [accessEnc, refreshEnc] = await Promise.all([
    encryptToken(tokens.access_token, ctx),
    encryptToken(nextRefresh, ctx),
  ]);

  const { data: written, error } = await supabase
    .from('facilitator_integrations')
    .update({
      access_token_enc: toBytea(accessEnc),
      refresh_token_enc: toBytea(refreshEnc),
      expires_at: expiryFrom(tokens.expires_in),
      last_refreshed_at: new Date().toISOString(),
      broken_at: null,
      broken_reason: null,
    })
    .eq('id', row.id)
    // Optimistic lock. Two concurrent bookings can both find the token expired
    // and both refresh; with Zoom's rotation the slower one is writing a
    // refresh token the provider has already invalidated. Losing the race here
    // means discarding our own write and using the winner's, which is correct —
    // the alternative is a row whose stored refresh token no longer works.
    .eq('updated_at', row.updated_at)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw error;

  if (!written) {
    const { data: fresh } = await supabase
      .from('facilitator_integrations')
      .select(ROW_COLUMNS)
      .eq('id', row.id)
      .maybeSingle<IntegrationRow>();
    if (fresh && !fresh.broken_at) {
      return decryptToken(fromBytea(fresh.access_token_enc), ctx);
    }
    throw new IntegrationError(
      `The ${CONFIG[ctx.provider].label} connection could not be refreshed. Please reconnect it.`,
    );
  }

  return tokens.access_token;
}

async function markBroken(supabase: SupabaseClient, id: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('facilitator_integrations')
    .update({ broken_at: new Date().toISOString(), broken_reason: reason.slice(0, 200) })
    .eq('id', id);
  if (error) console.error('[integrations] could not flag a broken connection', { id, error });
}

// ---------------------------------------------------------------------------
// Dashboard + disconnect
// ---------------------------------------------------------------------------

export interface ConnectionSummary {
  provider: Provider;
  label: string;
  connected: boolean;
  email: string | null;
  scopes: string[];
  connectedAt: string | null;
  broken: boolean;
  brokenReason: string | null;
}

/**
 * Every provider, connected or not — the Connections screen needs to offer the
 * ones that are missing, not only list the ones that exist.
 *
 * Note what is absent: the tokens. They are not selected, so they cannot leak
 * into a response by someone later spreading this object.
 */
export async function listConnections(
  supabase: SupabaseClient,
  facilitatorId: string,
): Promise<ConnectionSummary[]> {
  const { data, error } = await supabase
    .from('facilitator_integrations')
    .select('provider, external_email, scopes, connected_at, broken_at, broken_reason')
    .eq('facilitator_id', facilitatorId);
  if (error) throw error;

  const byProvider = new Map(
    (data ?? []).map((r) => [r.provider as Provider, r as Record<string, unknown>]),
  );

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      label: CONFIG[provider].label,
      connected: Boolean(row),
      email: (row?.external_email as string | null) ?? null,
      scopes: (row?.scopes as string[]) ?? [],
      connectedAt: (row?.connected_at as string | null) ?? null,
      broken: Boolean(row?.broken_at),
      brokenReason: (row?.broken_reason as string | null) ?? null,
    };
  });
}

/**
 * Disconnects, telling the provider first.
 *
 * The upstream revoke is attempted but not required: if it fails we still drop
 * our copy, because a facilitator who pressed Disconnect should never be left
 * with Hilom holding their credentials. The token then expires on its own, and
 * they can revoke from the provider's side.
 */
export async function disconnect(
  supabase: SupabaseClient,
  facilitatorId: string,
  provider: Provider,
): Promise<void> {
  const { data: row } = await supabase
    .from('facilitator_integrations')
    .select(ROW_COLUMNS)
    .eq('facilitator_id', facilitatorId)
    .eq('provider', provider)
    .maybeSingle<IntegrationRow>();

  if (row) {
    try {
      const token = await decryptToken(fromBytea(row.refresh_token_enc), { facilitatorId, provider });
      await revokeUpstream(provider, token);
    } catch (err) {
      console.warn('[integrations] upstream revoke failed; dropping local copy anyway', {
        provider,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { error } = await supabase
    .from('facilitator_integrations')
    .delete()
    .eq('facilitator_id', facilitatorId)
    .eq('provider', provider);
  if (error) throw error;
}

async function revokeUpstream(provider: Provider, token: string): Promise<void> {
  const config = CONFIG[provider];
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (config.tokenAuth === 'basic') {
    const { clientId, clientSecret } = await getSecret<OAuthSecret>(config.secretId);
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  await fetch(config.revokeUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ token }),
  });
}

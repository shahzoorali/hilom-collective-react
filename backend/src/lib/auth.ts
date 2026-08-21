/**
 * Verifies Cognito id_tokens presented by the browser as `Authorization: Bearer`.
 *
 * The point of this file is that `buyer_email` stops being something the client
 * asserts and becomes something Cognito attests to. Course access is permanent
 * and keyed to that address, so anything that lets a caller name an arbitrary
 * email is a way to provision access on someone else's account.
 *
 * `aws-jwt-verify` is Amazon's own verifier: it fetches and caches the pool's
 * JWKS, checks the RS256 signature, and enforces issuer, audience, `token_use`
 * and expiry. Doing this by hand with `node:crypto` is possible but is exactly
 * the kind of code that is subtly wrong in ways that only show up as a breach.
 *
 * Config comes from env, not Secrets Manager, deliberately: a user-pool id and
 * a public SPA client id are not secrets (both already ship in the frontend
 * bundle), and a secret fetch on this path would add latency and a failure mode
 * to every checkout for no security gain.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface VerifiedBuyer {
  /** Cognito `sub` — the stable identity, unlike email which can be changed. */
  sub: string;
  /** Always lowercased, so it matches however it was typed at sign-up. */
  email: string;
  givenName?: string;
  familyName?: string;
}

/** Thrown for any failure to establish who the caller is. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function getVerifier() {
  if (verifier) return verifier;

  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_SPA_CLIENT_ID;
  if (!userPoolId || !clientId) {
    // A misconfigured deploy must fail closed and loudly. Falling back to
    // trusting the request body here would silently reintroduce the exact hole
    // this module exists to close.
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_SPA_CLIENT_ID must both be set');
  }

  verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  return verifier;
}

/**
 * Returns the verified buyer, or throws `UnauthorizedError`.
 *
 * Note this reads the *id* token, not the access token: the email and name
 * claims we need live on the id token, and Cognito's access token carries no
 * email at all.
 */
export async function requireBuyer(event: APIGatewayProxyEventV2): Promise<VerifiedBuyer> {
  // API Gateway lowercases header names, but a direct/test invoke may not.
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) throw new UnauthorizedError('Sign in to continue');

  let payload: Record<string, unknown>;
  try {
    payload = (await getVerifier().verify(token)) as unknown as Record<string, unknown>;
  } catch (err) {
    // Deliberately not echoed to the caller: the reason a token failed is
    // useful to an attacker probing the endpoint and useless to a real buyer,
    // whose only remedy is to sign in again either way.
    console.warn('[auth.requireBuyer] token rejected:', err instanceof Error ? err.message : err);
    throw new UnauthorizedError('Your session has expired — sign in again');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!sub) throw new UnauthorizedError('Token has no subject');
  if (!email) throw new UnauthorizedError('Your account has no email address on file');

  // `email_verified` is enforced because Moodle's OAuth2 issuer runs with
  // `requireconfirmation=0` — it trusts Cognito's word on the address. If we
  // enrolled on an unverified claim, that trust would be misplaced.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new UnauthorizedError('Confirm your email address before purchasing');
  }

  return {
    sub,
    email,
    givenName: typeof payload.given_name === 'string' ? payload.given_name : undefined,
    familyName: typeof payload.family_name === 'string' ? payload.family_name : undefined,
  };
}

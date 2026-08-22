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
  return toBuyer(await verifyIdToken(event));
}

/**
 * Verifies the bearer id_token and returns its raw claims.
 *
 * Split out from `requireBuyer` so that callers needing claims beyond the buyer
 * fields — `requireUser`, for the `cognito:groups` role claim — can read them
 * off the same verified payload instead of verifying the token twice or, worse,
 * decoding it unverified.
 */
async function verifyIdToken(event: APIGatewayProxyEventV2): Promise<Record<string, unknown>> {
  // API Gateway lowercases header names, but a direct/test invoke may not.
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) throw new UnauthorizedError('Sign in to continue');

  try {
    return (await getVerifier().verify(token)) as unknown as Record<string, unknown>;
  } catch (err) {
    // Deliberately not echoed to the caller: the reason a token failed is
    // useful to an attacker probing the endpoint and useless to a real buyer,
    // whose only remedy is to sign in again either way.
    console.warn('[auth.requireBuyer] token rejected:', err instanceof Error ? err.message : err);
    throw new UnauthorizedError('Your session has expired — sign in again');
  }
}

/** Applies the buyer-identity rules to an already-verified payload. */
function toBuyer(payload: Record<string, unknown>): VerifiedBuyer {
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

/**
 * A verified caller plus their Cognito group memberships.
 *
 * Groups are the role model for the facilitator marketplace: `facilitator` and
 * `admin` are `CfnUserPoolGroup`s on the same pool that already issues buyer
 * tokens, so a facilitator is not a second identity system — it is the same
 * account with a claim on it. Cognito puts group names in `cognito:groups` on
 * the id token, which means the check costs nothing extra: the signature and
 * expiry were already verified above, and reading one more claim off the same
 * payload adds no call and no new failure mode.
 *
 * The claim is absent (not empty) for a user in no groups, which is the common
 * case for buyers — hence the defensive normalisation rather than a cast.
 */
export interface VerifiedUser extends VerifiedBuyer {
  groups: string[];
}

/**
 * `requireBuyer` with group claims attached.
 *
 * Deliberately additive: `requireBuyer` keeps its exact signature and behaviour
 * because checkout, ownership and every existing caller depend on it, and this
 * file is the one place where a subtle change becomes an access-control bug.
 */
export async function requireUser(event: APIGatewayProxyEventV2): Promise<VerifiedUser> {
  const payload = await verifyIdToken(event);
  const raw = payload['cognito:groups'];
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];
  return { ...toBuyer(payload), groups };
}

/**
 * Returns the caller only if they are in `group`, otherwise throws.
 *
 * The message is deliberately the same shape as an unauthenticated one: whether
 * a given account happens to hold the `admin` group is not something an
 * arbitrary caller should be able to probe for.
 */
export async function requireGroup(
  event: APIGatewayProxyEventV2,
  group: string,
): Promise<VerifiedUser> {
  const user = await requireUser(event);
  if (!user.groups.includes(group)) {
    console.warn(`[auth.requireGroup] ${user.sub} lacks group ${group}`);
    throw new UnauthorizedError('You do not have access to this area');
  }
  return user;
}

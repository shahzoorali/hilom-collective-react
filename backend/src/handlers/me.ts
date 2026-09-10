/**
 * The signed-in buyer's own account, as opposed to admin-cognito.ts which is
 * the same data seen from the outside.
 *
 *   GET   /me/owned-courses
 *   PATCH /me/profile        — rename yourself, in Cognito and in Moodle
 *
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
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, serverError, unauthorized } from '../lib/http.js';
import { requireBuyer, UnauthorizedError } from '../lib/auth.js';
import { getOwnedCourseIds } from '../lib/ownership.js';
import { getCognitoSecret, getMoodleSecret } from '../lib/secrets.js';
import { MoodleClient } from '../lib/moodle.js';

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

/** Long enough for a real name, short enough that neither Cognito's 2048-char
 *  attribute ceiling nor Moodle's 100-char column is ever the thing that says no. */
const MAX_NAME = 60;

let cognitoClient: CognitoIdentityProviderClient | undefined;

/**
 * PATCH /me/profile  { givenName, familyName }
 *
 * **Who.** `requireBuyer`, so the account being renamed is the one that owns
 * the presented id_token. The body carries the new name and nothing else —
 * never an email or a username — so there is no way to spell a request that
 * renames somebody else, and no way to move the address that course access is
 * keyed to.
 *
 * **Order: Cognito first, then Moodle.** Cognito is the identity of record and
 * Moodle is downstream of it. Writing Cognito first means a Moodle failure
 * leaves the name correct at the source and merely stale on the LMS, which the
 * next successful save (or the next `createUser`, for a buyer with no Moodle
 * account yet) repairs. The reverse order would leave Moodle asserting a name
 * the identity provider has never heard of. Same instinct as recording the
 * money before fulfilling.
 *
 * **A missing Moodle user is success, not failure.** Someone who has signed up
 * but never bought a course has no Moodle account at all; there is nothing to
 * rename, and `core_user_create_users` at first purchase will use the name
 * Cognito holds by then. Reporting that as an error would be a red banner for
 * a save that did exactly what it should.
 *
 * **The response echoes the saved name** because the caller's id_token still
 * carries the old claim — there is no refresh-token flow in the SPA, so the
 * token only picks the new name up at the next sign-in. The frontend caches
 * what comes back here and renders that over the stale claim.
 */
export async function updateProfile(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let buyer;
  try {
    buyer = await requireBuyer(event);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('me.updateProfile', err);
  }

  let body: { givenName?: unknown; familyName?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return badRequest('Malformed request body');
  }

  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const givenName = clean(body.givenName);
  const familyName = clean(body.familyName);

  // Both are required rather than "at least one": Moodle's firstname and
  // lastname are both NOT NULL, so a half-filled form would have to invent a
  // value for the other half, and inventing one silently is worse than asking.
  if (!givenName || !familyName) return badRequest('Enter both a first and a last name');
  if (givenName.length > MAX_NAME || familyName.length > MAX_NAME) {
    return badRequest(`Names must be ${MAX_NAME} characters or fewer`);
  }

  try {
    const { region, userPoolId } = await getCognitoSecret();
    if (!cognitoClient) cognitoClient = new CognitoIdentityProviderClient({ region });
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        // `sub` is accepted as the Username here and is the stable identity —
        // unlike the email, which is exactly the thing a rename shouldn't lean on.
        Username: buyer.sub,
        UserAttributes: [
          { Name: 'given_name', Value: givenName },
          { Name: 'family_name', Value: familyName },
        ],
      }),
    );
  } catch (err) {
    return serverError('me.updateProfile.cognito', err);
  }

  let moodleSynced = false;
  try {
    const { url, token } = await getMoodleSecret();
    const moodle = new MoodleClient(token, url);
    const user = await moodle.getUserByEmail(buyer.email);
    if (user) {
      await moodle.updateUserName(user.id, givenName, familyName);
      moodleSynced = true;
    }
  } catch (err) {
    // Not a 500: Cognito — the record of identity — already took the change.
    // Logged loudly so a persistently failing Moodle is visible in CloudWatch
    // rather than only in a course page showing the wrong name.
    console.error('[me.updateProfile] Moodle rename failed (Cognito already updated):', err);
  }

  return ok({ givenName, familyName, moodleSynced });
}

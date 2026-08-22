/**
 * Ensures a Cognito identity exists for a buyer at fulfillment time.
 *
 * This is now a lookup on the happy path, not a create: buyers sign in through
 * the Hosted UI before paying, so the account already exists by the time an
 * order is fulfilled. The create branch is kept as a fallback for orders that
 * reach fulfillment without one — a manually recorded payment, or a checkout
 * session created before the sign-in-first change shipped — because the
 * alternative is an order that took money and cannot be fulfilled at all.
 */
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoSecret } from './secrets.js';
import { sendAccountCreatedEmail } from './email.js';

let client: CognitoIdentityProviderClient | undefined;

async function getClient(): Promise<{ client: CognitoIdentityProviderClient; userPoolId: string }> {
  const { region, userPoolId } = await getCognitoSecret();
  if (!client) client = new CognitoIdentityProviderClient({ region });
  return { client, userPoolId };
}

/**
 * Returns the Cognito `sub` for the given email, creating the user if needed.
 *
 * Cognito's own built-in "here is your temporary password" email is
 * suppressed (MessageAction: 'SUPPRESS') in favor of our own SES-sent welcome
 * email — matching branding, sent from noreply@hilomcollective.com, and not
 * subject to Cognito's ~50 emails/day sandbox limit.
 *
 * This path — a Cognito account being admin-created rather than found — is
 * now the fallback case rather than the norm: checkout requires signing in via
 * Hosted UI before payment (see checkout.ts), so most buyers already have an
 * account by the time fulfillment calls this. It's kept for orders that reach
 * fulfillment without one — a manually recorded payment, or a checkout session
 * created before that change shipped — because the alternative is an order
 * that took money and cannot be fulfilled at all.
 */
export async function ensureCognitoUser(
  email: string,
  firstname: string,
  lastname: string,
): Promise<string> {
  const { client, userPoolId } = await getClient();

  try {
    const existing = await client.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
    );
    const sub = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error(`Cognito user ${email} has no sub attribute`);
    return sub;
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }

  const created = await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: firstname },
        { Name: 'family_name', Value: lastname },
      ],
    }),
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`AdminCreateUser for ${email} returned no sub attribute`);

  // Best-effort: a failed welcome email must not undo the account creation or
  // fail the enrollment — the buyer already paid, and this is recoverable
  // (support can resend, or the buyer can self-serve via "Forgot password").
  try {
    await sendAccountCreatedEmail(email, firstname);
  } catch (err) {
    console.error('sendAccountCreatedEmail failed', { email, err });
  }

  return sub;
}

/**
 * Adds a user to a Cognito group, creating nothing.
 *
 * This is how a facilitator actually gains access to their dashboard: the
 * `facilitators` row records the approval, but until the group lands on their
 * token, `requireGroup` keeps refusing them. The two have to happen together,
 * which is why admin approval calls this rather than only writing the row.
 *
 * Idempotent in Cognito — re-adding a member is a no-op, not an error.
 *
 * The group only appears in a token when one is *issued*, so someone approved
 * mid-session keeps a group-less token until they sign in again. That is why
 * the approval email tells them to sign in rather than linking them straight
 * into a dashboard that would bounce them.
 */
export async function addUserToGroup(email: string, groupName: string): Promise<void> {
  const { client: cognito, userPoolId } = await getClient();
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: groupName,
    }),
  );
}

/**
 * Removes a user from a group — the access half of suspending a facilitator.
 *
 * Tolerates a missing user: a facilitator row can exist without a Cognito
 * account (an application entered by staff before the person ever signed in),
 * and suspending one of those should not 500.
 */
export async function removeUserFromGroup(email: string, groupName: string): Promise<void> {
  const { client: cognito, userPoolId } = await getClient();
  try {
    await cognito.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: groupName,
      }),
    );
  } catch (err) {
    if (err instanceof UserNotFoundException) {
      console.warn('[cognito.removeUserFromGroup] no Cognito user for', email);
      return;
    }
    throw err;
  }
}

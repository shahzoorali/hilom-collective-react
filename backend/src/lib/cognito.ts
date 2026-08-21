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
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoSecret } from './secrets.js';

let client: CognitoIdentityProviderClient | undefined;

async function getClient(): Promise<{ client: CognitoIdentityProviderClient; userPoolId: string }> {
  const { region, userPoolId } = await getCognitoSecret();
  if (!client) client = new CognitoIdentityProviderClient({ region });
  return { client, userPoolId };
}

/**
 * Returns the Cognito `sub` for the given email, creating the user if needed.
 *
 * New accounts suppress Cognito's own "here is your temporary password"
 * invite: this path only runs as a fallback (checkout normally creates the
 * account itself via Hosted UI sign-in before payment — see checkout.ts), and
 * a buyer who is meant to sign in via SSO has no use for a password that
 * arrives out of nowhere. The enrollment-confirmation email (see
 * enrollment-email.ts) is what actually tells them their access is ready.
 *
 * Still relevant regardless of this path's frequency: the user pool's default
 * email sending is sandboxed to ~50/day and must move to an SES-backed
 * configuration before launch volume could plausibly exceed that.
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
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: firstname },
        { Name: 'family_name', Value: lastname },
      ],
      // This path only runs now when a buyer reaches fulfillment without
      // having signed in first (checkout requires it — see checkout.ts — so
      // this is the fallback, not the norm). Such a buyer is not expecting a
      // password and has no use for one: their real route in is Moodle SSO,
      // and the enrollment email (see enrollment-email.ts) is what tells them
      // that. Sending Cognito's own "temporary password" email on top would
      // just be a confusing, unusable credential arriving out of nowhere.
      MessageAction: 'SUPPRESS',
    }),
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`AdminCreateUser for ${email} returned no sub attribute`);
  return sub;
}

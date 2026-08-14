/**
 * Ensures a Cognito identity exists for a buyer at checkout time, even if they
 * never signed up first — the plan explicitly allows guest checkout. The
 * account is admin-created rather than self-registered, which is why it needs
 * its own client here instead of going through the Hosted UI.
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
 * New accounts are NOT given a suppressed invite: Cognito sends its own
 * "here is your temporary password" email by default. This uses Cognito's
 * built-in email sending, which is sandboxed to ~50 emails/day — fine for
 * early testing, but must move to an SES-backed configuration before launch
 * volume could plausibly exceed that.
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
    }),
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`AdminCreateUser for ${email} returned no sub attribute`);
  return sub;
}

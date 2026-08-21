/**
 * One-time: point the `hilom-users` Cognito pool at the ap-southeast-1 SES
 * identity instead of Cognito's own default sender (sandboxed to ~50/day —
 * see cognito.ts).
 *
 * ap-southeast-1 specifically, not the older ap-south-1 identity that already
 * has production access (which backend/src/lib/enrollment-email.ts uses):
 * Cognito's own built-in email sending requires the backing SES identity to be
 * in the *same region as the user pool* — unlike a Lambda calling the SES API
 * directly, which has no such constraint. The pool is ap-southeast-1, so this
 * is the one path that has no choice but to use the still-sandboxed identity,
 * and it will stay rate-limited until production access is separately
 * requested for ap-southeast-1 too.
 *
 * Not run automatically by anything, and deliberately not folded into CDK:
 * the pool itself (`ap-southeast-1_AA9IeeZ2z`) was created by hand and isn't
 * under CDK management yet — see the hardcoded default in
 * infra/lib/hilom-backend-stack.ts. Importing it properly is separate work.
 * This is a direct, reversible API call against the one setting that's
 * actually blocking launch.
 *
 * Prerequisite: the `hilomcollective.com` identity in ap-southeast-1 must be
 * verified (it was, 2026-08-21) — Cognito's UpdateUserPool call fails
 * immediately otherwise, before touching anything.
 *
 * Usage:
 *   AWS_PROFILE=<your profile> npx tsx scripts/configure-cognito-ses.ts
 *
 * Safe to re-run: it's a full replace of EmailConfiguration, not an
 * incremental change, so running it twice just sets the same values again.
 */
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = 'ap-southeast-1';
const USER_POOL_ID = 'ap-southeast-1_AA9IeeZ2z';
const ACCOUNT_ID = '651706741660';
const SES_IDENTITY_ARN = `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/hilomcollective.com`;
const SOURCE_ARN = `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/hilomcollective.com`;
const FROM = 'Hilom Collective <hello@hilomcollective.com>';

const client = new CognitoIdentityProviderClient({ region: REGION });

const before = await client.send(new DescribeUserPoolCommand({ UserPoolId: USER_POOL_ID }));
console.log('Current EmailConfiguration:', JSON.stringify(before.UserPool?.EmailConfiguration, null, 2));

await client.send(
  new UpdateUserPoolCommand({
    UserPoolId: USER_POOL_ID,
    EmailConfiguration: {
      EmailSendingAccount: 'DEVELOPER',
      SourceArn: SOURCE_ARN,
      From: FROM,
    },
  }),
);

const after = await client.send(new DescribeUserPoolCommand({ UserPoolId: USER_POOL_ID }));
console.log('New EmailConfiguration:', JSON.stringify(after.UserPool?.EmailConfiguration, null, 2));
console.log(
  `\nDone. Note: ${SES_IDENTITY_ARN} is still sandboxed as of 2026-08-21 — Cognito-triggered ` +
    'emails (invites, MFA codes, password resets) to unverified addresses will fail until SES ' +
    'production access is granted. Verify your own test address in SES to test this in the meantime.',
);

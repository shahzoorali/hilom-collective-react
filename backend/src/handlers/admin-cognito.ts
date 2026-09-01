/**
 * Admin → Accounts: the Cognito user pool itself.
 *
 *   GET /admin/cognito/users             ?q= ?limit= ?token=
 *   GET /admin/cognito/users/{username}
 *
 * **Why this screen exists.** Admin → People is derived from Postgres, so it
 * only shows someone who has bought, booked, registered or enquired. A person
 * who created an account and has done nothing else is invisible there — by
 * design, and documented as such (db/migrations/0022). This screen is the other
 * side of that line: it reads the user pool directly, so "who has actually
 * signed up?" has an answer somewhere in the admin UI.
 *
 * **Read-only, and it stays that way.** Cognito is the system of record for
 * identity. Disabling, deleting or resetting an account has real blast radius
 * (a disabled user cannot be re-enabled by them, a deleted `sub` orphans every
 * order that referenced it) and belongs in the AWS console behind IAM, not
 * behind the shared admin key. The IAM policy on this function grants only the
 * three read actions below.
 *
 * **Pagination is Cognito's, passed straight through.** `ListUsers` returns at
 * most 60 users per call and a `PaginationToken` for the next page; this
 * handler forwards that token as `?token=` rather than trying to assemble the
 * whole pool server-side. Search is a case-insensitive prefix on the email
 * attribute — the only substring-ish match `ListUsers` actually supports — so
 * the UI says "starts with" rather than implying a full-text search it cannot
 * do.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  UserNotFoundException,
  type UserType,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ok, notFound, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { getCognitoSecret } from '../lib/secrets.js';

/** One page of the pool. Chosen to match Cognito's own `ListUsers` ceiling so
 *  a page on screen is a page from the API, not a re-paginated slice of one. */
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 60;

let cachedClient: CognitoIdentityProviderClient | undefined;

async function getClient(): Promise<{ client: CognitoIdentityProviderClient; userPoolId: string }> {
  const { region, userPoolId } = await getCognitoSecret();
  if (!cachedClient) cachedClient = new CognitoIdentityProviderClient({ region });
  return { client: cachedClient, userPoolId };
}

const attr = (attrs: AttributeType[] | undefined, name: string): string | null =>
  attrs?.find((a) => a.Name === name)?.Value ?? null;

/** The shape the admin UI consumes — a flat projection of the parts of a
 *  Cognito user that answer "who is this and can they sign in?". */
interface AccountRow {
  username: string;
  sub: string | null;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  status: string | null;
  enabled: boolean;
  created_at: string | null;
  last_modified_at: string | null;
}

function toRow(u: UserType): AccountRow {
  const given = attr(u.Attributes, 'given_name');
  const family = attr(u.Attributes, 'family_name');
  const name = [given, family].filter(Boolean).join(' ') || attr(u.Attributes, 'name');
  return {
    username: u.Username ?? '',
    sub: attr(u.Attributes, 'sub'),
    email: attr(u.Attributes, 'email'),
    email_verified: attr(u.Attributes, 'email_verified') === 'true',
    name: name || null,
    status: u.UserStatus ?? null,
    enabled: u.Enabled ?? true,
    created_at: u.UserCreateDate?.toISOString() ?? null,
    last_modified_at: u.UserLastModifiedDate?.toISOString() ?? null,
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    const username = event.pathParameters?.username;
    if (method === 'GET' && username) {
      return await userDetail(decodeURIComponent(username));
    }
    if (method === 'GET' && path.endsWith('/admin/cognito/users')) {
      return await listAccounts(event.queryStringParameters ?? {});
    }
    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    return serverError('adminCognito', err);
  }
}

async function listAccounts(
  query: Record<string, string | undefined>,
): Promise<APIGatewayProxyResultV2> {
  const { client, userPoolId } = await getClient();

  const limit = Math.min(Number(query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const term = (query.q ?? '').trim();

  // `ListUsers` Filter is a tiny language, not a bound parameter: a stray `"`
  // breaks the expression. Only the prefix operator is broadly supported for
  // email, so that is all this exposes.
  const filter = term ? `email ^= "${term.replace(/"/g, '')}"` : undefined;

  const res = await client.send(
    new ListUsersCommand({
      UserPoolId: userPoolId,
      Limit: limit,
      PaginationToken: query.token || undefined,
      Filter: filter,
    }),
  );

  return ok({
    users: (res.Users ?? []).map(toRow),
    // Present only when there is another page. The client sends it back as
    // `?token=` to continue; absent means this is the last page.
    nextToken: res.PaginationToken ?? null,
    scope:
      'Every account in the Cognito user pool, including ones that have never ' +
      'transacted. Search matches the start of the email address.',
  });
}

async function userDetail(username: string): Promise<APIGatewayProxyResultV2> {
  const { client, userPoolId } = await getClient();

  try {
    const [user, groups] = await Promise.all([
      client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username })),
      client.send(
        new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, Limit: 60 }),
      ),
    ]);

    const row = toRow({
      Username: user.Username,
      Attributes: user.UserAttributes,
      UserStatus: user.UserStatus,
      Enabled: user.Enabled,
      UserCreateDate: user.UserCreateDate,
      UserLastModifiedDate: user.UserLastModifiedDate,
    });

    return ok({
      user: {
        ...row,
        // Everything the projection dropped, for the "raw" panel — MFA setup,
        // custom attributes, an unverified phone, whatever is actually on the
        // record. Name/value pairs, as Cognito returns them.
        attributes: (user.UserAttributes ?? [])
          .filter((a): a is { Name: string; Value: string } => Boolean(a.Name))
          .map((a) => ({ name: a.Name, value: a.Value ?? '' })),
      },
      groups: (groups.Groups ?? []).map((g) => ({
        name: g.GroupName ?? '',
        description: g.Description ?? null,
      })),
    });
  } catch (err) {
    if (err instanceof UserNotFoundException) return notFound('No account with that username.');
    throw err;
  }
}

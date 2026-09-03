/**
 * Connected meeting accounts — the facilitator's own OAuth connections.
 *
 *   GET    /facilitator/integrations                    (facilitator group)
 *   POST   /facilitator/integrations/{provider}/start   (facilitator group)
 *   GET    /facilitator/integrations/{provider}/callback  ← PUBLIC, see below
 *   DELETE /facilitator/integrations/{provider}         (facilitator group)
 *
 * ## Why the callback is unauthenticated
 *
 * Every other route here is scoped to the caller's own facilitator row, the
 * same rule facilitator-portal.ts enforces. The callback cannot be: it is a
 * *browser redirect from Google or Zoom*, and no bearer token survives that
 * hop. The `state` row is what authenticates it instead — a single-use,
 * 15-minute value this service generated and stored against one facilitator,
 * claimed with a delete-and-return so a captured redirect cannot be replayed
 * even once. Combined with PKCE, that is the standard construction and is
 * strictly stronger than a signed cookie would be here.
 *
 * The consequence to keep in mind: this handler must never accept a
 * facilitator id from the query string. It only ever learns who the flow
 * belongs to by claiming the state row.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, notFound, unauthorized, serverError, redirect } from '../lib/http.js';
import { requireGroup, UnauthorizedError } from '../lib/auth.js';
import {
  IntegrationError,
  completeConnect,
  disconnect,
  isProvider,
  listConnections,
  startConnect,
  type Provider,
} from '../lib/integrations.js';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';

/** Where a finished flow lands when the start request named nowhere. */
const DEFAULT_RETURN = '/facilitator/connections';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const provider = event.pathParameters?.provider;

  // The callback is handled before any auth, because by construction it
  // carries none.
  if (path.endsWith('/callback')) {
    try {
      return await callback(event);
    } catch (err) {
      return serverError('facilitatorIntegrations.callback', err);
    }
  }

  let user;
  try {
    user = await requireGroup(event, 'facilitator');
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('facilitatorIntegrations.auth', err);
  }

  // Awaited rather than returned bare — see the note in admin-facilitators.ts.
  try {
    const supabase = await getSupabase();
    const facilitatorId = await ownFacilitatorId(supabase, user);
    if (!facilitatorId) return notFound('No facilitator profile is linked to this account');

    if (!provider) {
      if (method === 'GET') return ok({ connections: await listConnections(supabase, facilitatorId) });
      return badRequest(`Unsupported method ${method}`);
    }

    if (!isProvider(provider)) return badRequest('Unknown provider');

    if (method === 'POST' && path.endsWith('/start')) {
      return await start(supabase, facilitatorId, provider, event);
    }
    if (method === 'DELETE') {
      await disconnect(supabase, facilitatorId, provider);
      return ok({ disconnected: true });
    }
    return badRequest(`Unsupported method ${method}`);
  } catch (err) {
    if (err instanceof IntegrationError) return badRequest(err.message);
    return serverError('facilitatorIntegrations', err);
  }
}

/**
 * Resolves the caller's own facilitator row id.
 *
 * Deliberately does *not* reuse facilitator-portal's `me()`, which also links
 * a null `cognito_sub` on first sign-in. Claiming an unlinked row is a
 * meaningful side effect and belongs to the flow that owns it; connecting a
 * Zoom account should not quietly adopt a facilitator row.
 */
async function ownFacilitatorId(
  supabase: SupabaseClient,
  user: { sub: string; email: string },
): Promise<string | null> {
  const { data, error } = await supabase
    .from('facilitators')
    .select('id')
    .eq('cognito_sub', user.sub)
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  return data?.id ?? null;
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Only same-site paths are accepted as a return target. An open redirect on a
 * URL a facilitator is about to be bounced through is exactly the shape used to
 * make a phishing link look legitimate.
 */
function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  return value.slice(0, 200);
}

async function start(
  supabase: SupabaseClient,
  facilitatorId: string,
  provider: Provider,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const returnTo = safeReturnTo(parseBody(event).returnTo);
  const { authorizeUrl } = await startConnect(supabase, facilitatorId, provider, returnTo);
  // Returned as JSON rather than a 302: the caller is `fetch` from the
  // dashboard, which would follow a redirect into a CORS failure against
  // accounts.google.com. The frontend does the navigating.
  return ok({ authorizeUrl });
}

/**
 * The provider's redirect back.
 *
 * Always answers with a 302 to the dashboard, never JSON — a human is looking
 * at this, not a script. Failures carry a short reason in the query string so
 * the Connections screen can say what went wrong.
 */
async function callback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters ?? {};
  const supabase = await getSupabase();

  const back = (to: string, query: Record<string, string>) =>
    redirect(`${FRONTEND_URL}${to}?${new URLSearchParams(query).toString()}`);

  // The user pressed Cancel on the consent screen. Not an error worth a stack
  // trace — the state row is simply left to expire.
  if (params.error) {
    return back(DEFAULT_RETURN, { connected: 'cancelled' });
  }

  const state = params.state;
  const code = params.code;
  if (!state || !code) return back(DEFAULT_RETURN, { connected: 'error', reason: 'missing_code' });

  try {
    const { provider, returnTo } = await completeConnect(supabase, state, code);
    return back(returnTo ?? DEFAULT_RETURN, { connected: 'ok', provider });
  } catch (err) {
    if (err instanceof IntegrationError) {
      console.warn('[facilitatorIntegrations] connect rejected', { message: err.message });
      return back(DEFAULT_RETURN, { connected: 'error', reason: err.message.slice(0, 160) });
    }
    console.error('[facilitatorIntegrations] connect failed', err);
    return back(DEFAULT_RETURN, { connected: 'error', reason: 'unexpected' });
  }
}

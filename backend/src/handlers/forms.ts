/**
 * Public rendering and submission of admin-created forms.
 *
 *   GET  /forms/{slug}              — field definitions, so the page can render
 *   POST /forms/{slug}/submissions  — store one submission
 *
 * The community signup form does NOT come through here — it posts to
 * /community/submit and is emailed to the team via SES. This endpoint is for
 * forms an admin builds in the CMS, whose submissions are stored and read back
 * in the admin.
 *
 * Submissions are validated against the stored field definitions rather than
 * trusted: this endpoint is unauthenticated and internet-facing, so the form
 * definition is the only thing that decides what a submission may contain.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError, json } from '../lib/http.js';
import { getSecret } from '../lib/secrets.js';
import { stripTags } from '../lib/sanitize.js';
import type { FormField } from '../lib/cms-blocks.js';

const MAX_TEXT_LENGTH = 5000;
/** Submissions allowed from one IP within the window below. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 10;
/** Bots fill every field they find, including one CSS-hidden from humans. */
const HONEYPOT_FIELD = '_website';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const slug = event.pathParameters?.slug;
  if (!slug) return notFound('Form not found');

  try {
    return event.requestContext.http.method === 'POST' ? submit(slug, event) : detail(slug);
  } catch (err) {
    return serverError('forms', err);
  }
}

async function detail(slug: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('forms')
    // notify_email is internal configuration and is not returned publicly.
    .select('slug, name, fields, submit_label, success_message')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Form not found');
  return ok({ form: data });
}

async function submit(
  slug: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
  } catch {
    return badRequest('Invalid request body');
  }

  const supabase = await getSupabase();
  const { data: form, error } = await supabase
    .from('forms')
    .select('id, fields, success_message')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  if (!form) return notFound('Form not found');

  const ipHash = await hashIp(event.requestContext.http.sourceIp);
  if (await isRateLimited(ipHash)) {
    return json(429, { error: 'Too many submissions. Please try again in a few minutes.' });
  }

  const fields = (form.fields ?? []) as FormField[];
  let data: Record<string, unknown>;
  try {
    data = collect(fields, body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'Invalid submission');
  }

  const { error: insertError } = await supabase.from('form_submissions').insert({
    form_id: form.id,
    data,
    ip_hash: ipHash,
    user_agent: (event.headers['user-agent'] ?? '').slice(0, 500),
    is_spam: Boolean(body[HONEYPOT_FIELD]),
  });
  if (insertError) throw insertError;

  // The same response either way: telling a bot it was flagged just teaches it
  // to stop filling the honeypot.
  return ok({ ok: true, message: form.success_message });
}

/** Copies only declared fields out of the request, enforcing each one's rules. */
function collect(fields: FormField[], body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = body[field.name];

    if (field.type === 'checkboxGroup') {
      const values = Array.isArray(raw) ? raw.map(String) : [];
      const allowed = new Set(field.options ?? []);
      const chosen = values.filter((v) => allowed.has(v));
      if (field.required && chosen.length === 0) throw new Error(`${field.label} is required`);
      out[field.name] = chosen;
      continue;
    }

    const value = raw === undefined || raw === null ? '' : stripTags(String(raw)).trim();
    if (!value) {
      if (field.required) throw new Error(`${field.label} is required`);
      out[field.name] = '';
      continue;
    }
    if (value.length > MAX_TEXT_LENGTH) throw new Error(`${field.label} is too long`);
    if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      throw new Error(`${field.label} must be a valid email address`);
    }
    if (field.type === 'select' && field.options?.length && !field.options.includes(value)) {
      throw new Error(`${field.label} is not one of the available options`);
    }
    out[field.name] = value;
  }

  return out;
}

/**
 * Salted with the admin key, which is already in Secrets Manager and already
 * readable by this function's role. An unsalted hash of an IPv4 address is
 * trivially reversible — the whole space is only four billion entries.
 */
async function hashIp(ip: string): Promise<string> {
  const { key } = await getSecret<{ key: string }>(
    process.env.ADMIN_KEY_SECRET_ID ?? 'hilom/admin-api-key',
  );
  return createHash('sha256').update(`${key}:${ip}`).digest('hex');
}

async function isRateLimited(ipHash: string): Promise<boolean> {
  const supabase = await getSupabase();
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error } = await supabase
    .from('form_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('created_at', since);

  // A failed rate-limit check must not block a genuine enquiry.
  if (error) return false;
  return (count ?? 0) >= RATE_LIMIT;
}

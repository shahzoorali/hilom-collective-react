/**
 * Public rendering and submission of admin-created forms.
 *
 *   GET  /forms/{slug}              — field definitions, so the page can render
 *   POST /forms/{slug}/submissions  — store one submission
 *
 * The community signup form does NOT come through here — it posts to
 * /community/submit and is always emailed to the team. This endpoint is for
 * forms an admin builds in the CMS: every submission is stored and readable in
 * Admin → Forms regardless of configuration, and is *also* emailed if the form
 * has a `notify_email` set (Admin → Forms → edit form). Until 2026-08-24 that
 * field was configurable but silently did nothing — a submission landed only
 * in the admin table, so a form nobody thought to check the admin for (like
 * the retreat waitlist) could go unnoticed indefinitely.
 *
 * Submissions are validated against the stored field definitions rather than
 * trusted: this endpoint is unauthenticated and internet-facing, so the form
 * definition is the only thing that decides what a submission may contain.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, serverError, json } from '../lib/http.js';
import { getSecret } from '../lib/secrets.js';
import { stripTags } from '../lib/sanitize.js';
import type { FormField } from '../lib/cms-blocks.js';
import { verifyRecaptcha } from '../lib/recaptcha.js';
import { buildFormNotificationEmail } from '../lib/form-notification.js';

const MAX_TEXT_LENGTH = 5000;
/** Submissions allowed from one IP within the window below. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 10;
/** Bots fill every field they find, including one CSS-hidden from humans. */
const HONEYPOT_FIELD = '_website';

// Same region/identity as every other Hilom sender — see community.ts.
const sesClient = new SESv2Client({ region: 'ap-south-1' });
const SENDER = 'Hilom Collective Website <website@hilomcollective.com>';

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
    // requires_captcha IS returned — the page needs it to know whether to
    // load the widget and attach a token before submitting.
    .select('slug, name, fields, submit_label, success_message, requires_captcha')
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
    .select('id, name, fields, success_message, requires_captcha, notify_email')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  if (!form) return notFound('Form not found');

  if (form.requires_captcha) {
    // Action is derived from the form's own slug, not a fixed string: a token
    // minted for one form must not be replayable against a different one.
    // Google's action names allow only [a-zA-Z0-9_/] — hyphens (common in
    // slugs) are swapped for underscores rather than rejected.
    const action = `form_${slug.replace(/[^a-zA-Z0-9_/]/g, '_')}`;
    if (!(await verifyRecaptcha(body.captchaToken, action))) {
      return badRequest('Captcha check failed — please try again.');
    }
  }

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

  const isSpam = Boolean(body[HONEYPOT_FIELD]);
  const { error: insertError } = await supabase.from('form_submissions').insert({
    form_id: form.id,
    data,
    ip_hash: ipHash,
    user_agent: (event.headers['user-agent'] ?? '').slice(0, 500),
    is_spam: isSpam,
  });
  if (insertError) throw insertError;

  // Honeypot catches never notify — the whole point of a silent flag is that
  // it costs the bot nothing to trip, and mailing the team on every trip would
  // just teach them to ignore this inbox. A genuine submission is stored either
  // way, so nothing is lost by not emailing the ones that failed the honeypot.
  if (form.notify_email && !isSpam) {
    // Best-effort: a submission the buyer was told succeeded must not become a
    // 500 because the notification email happened to fail.
    await notifySubmission(form.notify_email, form.name, fields, data).catch((err: unknown) =>
      console.error(`[forms.notifySubmission] form=${slug}`, err),
    );
  }

  // The same response either way: telling a bot it was flagged just teaches it
  // to stop filling the honeypot.
  return ok({ ok: true, message: form.success_message });
}

/**
 * Emails the form's configured recipient, branded like every other Hilom
 * email even though this one goes to the team rather than a member — see the
 * same note in community.ts. Content shaping lives in lib/form-notification.ts,
 * where it can be tested without mocking SES.
 */
async function notifySubmission(
  recipient: string,
  formName: string,
  fields: FormField[],
  data: Record<string, unknown>,
): Promise<void> {
  const { subject, textBody, htmlBody, replyTo } = buildFormNotificationEmail(formName, fields, data);

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [recipient] },
      // Lets the team just hit "Reply" to respond straight to the submitter,
      // same as the community form — only set when a field on the form
      // actually collected an email address.
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: textBody },
            Html: { Data: htmlBody },
          },
        },
      },
    }),
  );
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

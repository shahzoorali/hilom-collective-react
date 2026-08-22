/**
 * Admin form definitions and submissions.
 *
 *   GET    /admin/forms
 *   POST   /admin/forms
 *   GET    /admin/forms/{formId}
 *   PUT    /admin/forms/{formId}
 *   DELETE /admin/forms/{formId}
 *   GET    /admin/forms/{formId}/submissions
 *   DELETE /admin/forms/{formId}/submissions/{submissionId}
 *
 * Submissions hold names, email addresses, and free-text messages, so every
 * route here is admin-only — there is no public read path for them anywhere.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, json, isAuthorizedAdmin } from '../lib/http.js';
import { stripTags } from '../lib/sanitize.js';
import { validateFormFields, BlockValidationError } from '../lib/cms-blocks.js';
import { normalizeSlug, slugify, SlugError } from '../lib/slug.js';

const FORM_COLUMNS =
  'id, slug, name, fields, submit_label, success_message, notify_email, requires_captcha, updated_at';
const SUBMISSION_PAGE_SIZE = 200;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const formId = event.pathParameters?.formId;
  const submissionId = event.pathParameters?.submissionId;

  try {
    if (formId && submissionId) return await removeSubmission(formId, submissionId);
    if (formId && path.includes('/submissions')) return await listSubmissions(formId);
    if (formId) {
      if (method === 'GET') return await get(formId);
      if (method === 'PUT') return await update(formId, parseBody(event));
      if (method === 'DELETE') return await remove(formId, event.queryStringParameters?.force === '1');
      return badRequest(`Unsupported method ${method}`);
    }
    if (method === 'POST') return await create(parseBody(event));
    return await list();
  } catch (err) {
    if (err instanceof BlockValidationError || err instanceof SlugError) return badRequest(err.message);
    return serverError('adminForms', err);
  }
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new BlockValidationError('Request body is not valid JSON');
  }
}

async function list(): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('forms').select(FORM_COLUMNS).order('name');
  if (error) throw error;

  // Submission counts make the list useful at a glance ("did anyone reply?").
  //
  // Counted in Postgres, one HEAD request per form, rather than by selecting
  // every submission row and tallying here: PostgREST caps a plain select at
  // its max-rows limit, so the old tally silently stopped counting past the
  // first 1000 submissions and reported numbers that were simply wrong. There
  // are a handful of forms, so the fan-out is small and fully parallel.
  const forms = data ?? [];
  const counts = await Promise.all(
    forms.map(async (form) => {
      const { count, error: countError } = await supabase
        .from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('form_id', form.id);
      if (countError) throw countError;
      return count ?? 0;
    }),
  );

  return ok({
    forms: forms.map((form, i) => ({ ...form, submission_count: counts[i] })),
  });
}

async function get(formId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('forms').select(FORM_COLUMNS).eq('id', formId).maybeSingle();
  if (error) throw error;
  if (!data) return notFound('Form not found');
  return ok({ form: data });
}

async function create(body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const name = stripTags(String(body.name ?? '')).trim();
  if (!name) return badRequest('name is required');
  const slug = normalizeSlug(body.slug ? body.slug : slugify(name));

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('forms')
    .insert({
      name,
      slug,
      fields: validateFormFields(body.fields ?? []),
      // Defaults to protected — an admin has to deliberately opt a form out,
      // rather than needing to remember to opt each new form in.
      requires_captcha: body.requires_captcha === undefined ? true : Boolean(body.requires_captcha),
    })
    .select(FORM_COLUMNS)
    .maybeSingle();

  if (error?.code === '23505') return json(409, { error: `A form with slug "${slug}" already exists` });
  if (error) throw error;
  return ok({ form: data });
}

async function update(formId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResultV2> {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = stripTags(String(body.name)).trim();
  if (body.fields !== undefined) patch.fields = validateFormFields(body.fields);
  if (body.submit_label !== undefined) patch.submit_label = stripTags(String(body.submit_label)).slice(0, 100);
  if (body.success_message !== undefined) {
    patch.success_message = stripTags(String(body.success_message)).slice(0, 1000);
  }
  if (body.notify_email !== undefined) {
    const email = String(body.notify_email).trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return badRequest('notify_email is not valid');
    patch.notify_email = email || null;
  }
  if (body.requires_captcha !== undefined) patch.requires_captcha = Boolean(body.requires_captcha);
  if (Object.keys(patch).length === 0) return badRequest('Nothing to update');

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('forms')
    .update(patch)
    .eq('id', formId)
    .select(FORM_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  if (!data) return notFound('Form not found');
  return ok({ form: data });
}

async function remove(formId: string, force: boolean): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  if (!force) {
    // Deleting the form cascades to its submissions, so losing enquiries must be
    // an explicit choice rather than a side effect of tidying up forms.
    const { count } = await supabase
      .from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('form_id', formId);

    if ((count ?? 0) > 0) {
      return json(409, {
        error: `This form has ${count} stored submissions, which would be deleted with it.`,
        submission_count: count,
      });
    }
  }

  const { error } = await supabase.from('forms').delete().eq('id', formId);
  if (error) throw error;
  return ok({ deleted: true });
}

async function listSubmissions(formId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('form_submissions')
    // ip_hash is not returned: it exists for rate limiting, not for the admin UI.
    .select('id, data, is_spam, user_agent, created_at')
    .eq('form_id', formId)
    .order('created_at', { ascending: false })
    .limit(SUBMISSION_PAGE_SIZE);

  if (error) throw error;
  return ok({ submissions: data ?? [] });
}

async function removeSubmission(formId: string, submissionId: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const { error } = await supabase
    .from('form_submissions')
    .delete()
    .eq('id', submissionId)
    .eq('form_id', formId);

  if (error) throw error;
  return ok({ deleted: true });
}

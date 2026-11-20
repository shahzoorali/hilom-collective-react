/**
 * Admin view of community sign-ups (0075).
 *
 *   GET  /admin/community                 ?q= ?consent=yes|no ?interest= ?source=form|import
 *   GET  /admin/community.csv             (same filters)
 *   POST /admin/community/{id}/withdraw-consent
 *
 * Authorized with the shared admin key, like the other core-stack admin
 * endpoints.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, notFound, serverError, unauthorized, isAuthorizedAdmin } from '../lib/http.js';
import { csvResponse } from '../lib/csv.js';

const MAX_ROWS = 5000;

const COLUMNS =
  'id, email, first_name, last_name, interests, messages, marketing_consent, marketing_consent_at, ' +
  'marketing_consent_withdrawn_at, source, submission_count, first_submitted_at, last_submitted_at';

export interface SignupRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  interests: string[];
  messages: { at: string; text: string }[];
  marketing_consent: boolean;
  marketing_consent_at: string | null;
  marketing_consent_withdrawn_at: string | null;
  source: 'form' | 'import';
  submission_count: number;
  first_submitted_at: string;
  last_submitted_at: string;
}

export interface SignupFilters {
  q?: string;
  consent?: string;
  interest?: string;
  source?: string;
}

/**
 * Filtering happens here rather than in SQL: the table is small (one row per
 * person) and this keeps the name/email/message search simple and testable.
 */
export function filterSignups(rows: SignupRow[], f: SignupFilters): SignupRow[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.consent === 'yes' && !r.marketing_consent) return false;
    if (f.consent === 'no' && r.marketing_consent) return false;
    if (f.source && r.source !== f.source) return false;
    if (f.interest && !r.interests.some((i) => i.toLowerCase() === f.interest!.toLowerCase())) return false;
    if (q) {
      const hay = [r.email, r.first_name, r.last_name, ...r.interests, ...r.messages.map((m) => m.text)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const manila = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : '';

export function signupCsvRows(rows: SignupRow[]): { header: string[]; lines: unknown[][] } {
  const header = [
    'First submitted', 'Last submitted', 'First name', 'Last name', 'Email', 'Interests',
    'Latest message', 'All messages', 'Marketing consent', 'Consent date', 'Consent withdrawn',
    'Submissions', 'Source',
  ];
  const lines = rows.map((r) => {
    const latest = r.messages.length ? r.messages[r.messages.length - 1]!.text : '';
    return [
      manila(r.first_submitted_at),
      manila(r.last_submitted_at),
      r.first_name ?? '',
      r.last_name ?? '',
      r.email,
      r.interests.join('; '),
      latest,
      r.messages.map((m) => `[${manila(m.at)}] ${m.text}`).join(' | '),
      r.marketing_consent ? 'Yes' : 'No',
      manila(r.marketing_consent_at),
      manila(r.marketing_consent_withdrawn_at),
      r.submission_count,
      r.source,
    ];
  });
  return { header, lines };
}

async function load(): Promise<SignupRow[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('community_signups')
    .select(COLUMNS)
    .order('last_submitted_at', { ascending: false })
    .limit(MAX_ROWS)
    .returns<SignupRow[]>();
  if (error) throw error;
  return data ?? [];
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers ?? {}))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const q = (event.queryStringParameters ?? {}) as SignupFilters;

  try {
    if (method === 'GET' && path.endsWith('/admin/community.csv')) {
      const rows = filterSignups(await load(), q);
      const { header, lines } = signupCsvRows(rows);
      return csvResponse(`hilom-community-${new Date().toISOString().slice(0, 10)}.csv`, header, lines);
    }

    if (method === 'GET' && path.endsWith('/admin/community')) {
      const all = await load();
      const rows = filterSignups(all, q);
      const interests = [...new Set(all.flatMap((r) => r.interests))].sort();
      return ok({
        signups: rows,
        total: all.length,
        consented: all.filter((r) => r.marketing_consent).length,
        interests,
        truncated: all.length >= MAX_ROWS,
      });
    }

    const id = event.pathParameters?.id;
    if (method === 'POST' && id && path.endsWith('/withdraw-consent')) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('community_signups')
        .update({ marketing_consent: false, marketing_consent_withdrawn_at: new Date().toISOString() })
        .eq('id', id)
        .select(COLUMNS)
        .maybeSingle<SignupRow>();
      if (error) throw error;
      if (!data) return notFound('Sign-up not found');
      return ok({ signup: data });
    }

    return badRequest(`Unsupported ${method} ${path}`);
  } catch (err) {
    return serverError('adminCommunity', err);
  }
}

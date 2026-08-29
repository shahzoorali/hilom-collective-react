/**
 * Admin → People: everyone this platform knows about, in one list.
 *
 *   GET /admin/people              ?q= ?source= ?sort= ?limit=
 *   GET /admin/people.csv          ?q= ?source=
 *   GET /admin/people/{email}
 *
 * **This is a read-only surface, and it stays that way.** There is no users
 * table to edit (see db/migrations/0022 for why), so the only honest write
 * here would be one that reaches into orders, bookings or registrations — and
 * those already have screens that know their own rules about refunds, seats
 * and audit trails. A "delete this person" button here would silently mean
 * something different in each of the four tables it touched. Corrections
 * belong on the record that is wrong.
 *
 * **The list is derived, so it can only ever be as complete as the database.**
 * Someone who created a Cognito account and never bought, booked, or enquired
 * does not appear, because nothing in Postgres has heard of them. That is
 * stated plainly in the response as `scope`, and the UI repeats it, rather
 * than letting an operator conclude that a directory labelled "People" is
 * everyone.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, notFound, badRequest, unauthorized, serverError, isAuthorizedAdmin } from '../lib/http.js';
import { actorFromEvent, recordAudit } from '../lib/audit.js';
import { isOutstanding, paidCentavos, outstandingCentavos, nextDueCharge } from '../lib/event-ticketing.js';
import { csvResponse } from '../lib/csv.js';

/** Mirrors the columns of public.people_directory. */
interface PersonRow extends Record<string, unknown> {
  email: string;
  full_name: string | null;
  cognito_sub: string | null;
  sources: string[];
  course_orders: number;
  event_registrations: number;
  events_attending: number;
  bookings: number;
  enquiries: number;
  lifetime_centavos: number;
  first_seen_at: string;
  last_seen_at: string;
}

/** The registration columns this screen reads back; the rest stay on their own screens. */
interface RegistrationSummary extends Record<string, unknown> {
  id: string;
  refund_centavos: number | null;
  refunded_at: string | null;
}

/** One row of the instalment ledger. */
interface ChargeRow extends Record<string, unknown> {
  id: string;
  registration_id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: 'scheduled' | 'awaiting_payment' | 'paid' | 'waived' | 'void' | 'refunded';
}

interface BookingSummary extends Record<string, unknown> {
  refund_centavos: number | null;
  refunded_at: string | null;
}

const SOURCES = ['course_order', 'event_registration', 'event_attendee', 'booking', 'enquiry'] as const;
type Source = (typeof SOURCES)[number];

const isSource = (value: string): value is Source => (SOURCES as readonly string[]).includes(value);

/** What the list can be ordered by. An allowlist, because it reaches a query. */
const SORTS: Record<string, { column: string; ascending: boolean }> = {
  recent: { column: 'last_seen_at', ascending: false },
  oldest: { column: 'first_seen_at', ascending: true },
  value: { column: 'lifetime_centavos', ascending: false },
  name: { column: 'full_name', ascending: true },
  email: { column: 'email', ascending: true },
};

/**
 * A ceiling on one page of a directory that grows with the business. Chosen to
 * match the registrations queue (500) so both screens fail the same way, and
 * reported back as `truncated` so the count on screen is never quietly wrong.
 */
const MAX_ROWS = 500;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAuthorizedAdmin(event.headers))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const query = event.queryStringParameters ?? {};

  try {
    if (method === 'GET' && path.endsWith('/admin/people.csv')) {
      return await peopleCsv(query, event);
    }
    // Path parameters arrive percent-decoded once by API Gateway; an address
    // with a '+' tag in it still needs the decode below to survive.
    const email = event.pathParameters?.email;
    if (method === 'GET' && email) {
      return await personDetail(safeDecode(email));
    }
    if (method === 'GET' && path.endsWith('/admin/people')) {
      return await people(query);
    }
    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    return serverError('adminPeople', err);
  }
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Escapes a value going into a PostgREST filter string.
 *
 * These filters are a comma-separated mini-language, not bound parameters: an
 * unescaped comma closes the current condition and starts a new one, and a '%'
 * silently widens an ilike to match far more than was asked for.
 */
const filterSafe = (value: string): string => value.replace(/[%,()\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The directory, filtered and sorted.
 *
 * Filtering by source happens in SQL through `contains` on the sources array
 * rather than in JS after the fact, so "show me only enquiries" does not first
 * pull every customer over the wire and then throw most of them away.
 */
async function people(query: Record<string, string | undefined>): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  const sort = SORTS[query.sort ?? 'recent'] ?? SORTS.recent!;
  const limit = Math.min(Number(query.limit) || MAX_ROWS, MAX_ROWS);

  let builder = supabase.from('people_directory').select('*');

  const term = (query.q ?? '').trim();
  if (term) {
    const safe = filterSafe(term);
    builder = builder.or(`email.ilike.%${safe}%,full_name.ilike.%${safe}%`);
  }
  if (query.source && isSource(query.source)) {
    builder = builder.contains('sources', [query.source]);
  }

  const { data, error } = await builder
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // One more than the cap, so "there are more than this" is a fact rather
    // than a guess made from a full page.
    .limit(limit + 1)
    .returns<PersonRow[]>();
  if (error) throw error;

  const rows = data ?? [];
  const truncated = rows.length > limit;

  return ok({
    people: truncated ? rows.slice(0, limit) : rows,
    truncated,
    scope:
      'Everyone with an order, registration, booking or enquiry. Cognito accounts ' +
      'that have never transacted do not appear.',
  });
}

/**
 * One person, with the actual records behind each number on their row.
 *
 * Four queries rather than a join: these tables have nothing to do with each
 * other except this email, and a five-way outer join to assemble what is
 * really four independent lists would multiply rows against each other for no
 * gain. They are also individually tiny for one person.
 */
async function personDetail(rawEmail: string): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes('@')) return badRequest('Not an email address.');

  const { data: person, error } = await supabase
    .from('people_directory')
    .select('*')
    .eq('email', email)
    .maybeSingle<PersonRow>();
  if (error) throw error;
  if (!person) return notFound('Nobody here by that address.');

  const [orders, registrations, bookings, enquiries] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, product_id, amount_centavos, currency, status, created_at, updated_at, ' +
          'paymongo_payment_id, error_detail, products(name)',
      )
      .ilike('buyer_email', email)
      .order('created_at', { ascending: false }),
    supabase
      .from('event_registrations')
      .select(
        'id, event_id, status, seat_no, buyer_email, registrant_name, registrant_email, ' +
          'plan_name, plan_kind, total_centavos, currency, created_at, flagged_at, ' +
          'refund_centavos, refunded_at, refund_reference, events(title, starts_at)',
      )
      // Both roles: they may have paid for a place someone else is sitting in,
      // or be sitting in one somebody else paid for. The row on the directory
      // counts both, so the detail has to show both.
      .or(`buyer_email.ilike.${filterSafe(email)},registrant_email.ilike.${filterSafe(email)}`)
      .order('created_at', { ascending: false }),
    supabase
      .from('bookings')
      .select(
        'id, facilitator_id, status, starts_at, ends_at, price_centavos, currency, created_at, ' +
          'paymongo_payment_id, refund_centavos, refunded_at, refund_reference, ' +
          'facilitators(display_name)',
      )
      .ilike('client_email', email)
      .order('starts_at', { ascending: false }),
    supabase
      .from('form_submissions')
      .select('id, form_id, data, created_at, forms(name)')
      .eq('is_spam', false)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  for (const result of [orders, registrations, bookings, enquiries]) {
    if (result.error) throw result.error;
  }

  // The instalment ledger for whatever registrations came back. Without it a
  // person on a four-payment plan shows only the plan total, which is the one
  // number that answers neither "have they paid?" nor "what do they owe?".
  const registrationRows = (registrations.data ?? []) as unknown as RegistrationSummary[];
  const charges = await chargesFor(
    supabase,
    registrationRows.map((r) => r.id),
  );
  const now = Date.now();
  const withCharges = registrationRows.map((r) => {
    const rows = charges.get(r.id) ?? [];
    const overdue = rows.filter((c) => isOutstanding(c.status) && Date.parse(c.due_at) < now);
    return {
      ...r,
      charges: rows,
      paid_centavos: paidCentavos(rows),
      outstanding_centavos: outstandingCentavos(rows),
      overdue_centavos: overdue.reduce((acc, c) => acc + c.amount_centavos, 0),
      overdue_count: overdue.length,
      next_due: nextDueCharge(rows),
    };
  });

  // form_submissions keeps its email inside author-defined JSON, so it cannot
  // be filtered in the query the way the other three are — this is the one
  // source that has to be matched here.
  const matchedEnquiries = (enquiries.data ?? []).filter((row) => {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const candidate = data.email ?? data.email_address;
    return typeof candidate === 'string' && candidate.trim().toLowerCase() === email;
  });

  const bookingRows = (bookings.data ?? []) as unknown as BookingSummary[];

  return ok({
    person,
    orders: orders.data ?? [],
    registrations: withCharges,
    bookings: bookingRows,
    enquiries: matchedEnquiries,
    // Computed here rather than in the browser so the screen and the numbers
    // can never disagree about which statuses count as money received. The
    // directory's own `lifetime_centavos` answers a different question — it is
    // every source added up — so it is left alone and this sits beside it.
    money: {
      registrations_paid_centavos: withCharges.reduce((a, r) => a + r.paid_centavos, 0),
      registrations_outstanding_centavos: withCharges.reduce((a, r) => a + r.outstanding_centavos, 0),
      registrations_overdue_centavos: withCharges.reduce((a, r) => a + r.overdue_centavos, 0),
      // What the cancellation policies say is owed back but has not been sent.
      refunds_owed_centavos:
        bookingRows.reduce(
          (a, b) => a + (b.refunded_at ? 0 : Number(b.refund_centavos ?? 0)),
          0,
        ) +
        withCharges.reduce(
          (a, r) => a + (r.refunded_at ? 0 : Number(r.refund_centavos ?? 0)),
          0,
        ),
    },
  });
}

/**
 * The instalment ledger for a set of registrations, keyed by registration.
 *
 * One `in` query rather than one per registration: somebody who has come to
 * six retreats would otherwise cost six round trips to render a panel that is
 * already four queries deep.
 */
async function chargesFor(
  supabase: Awaited<ReturnType<typeof getSupabase>>,
  registrationIds: string[],
): Promise<Map<string, ChargeRow[]>> {
  const byRegistration = new Map<string, ChargeRow[]>();
  if (registrationIds.length === 0) return byRegistration;

  const { data, error } = await supabase
    .from('registration_charges')
    .select(
      'id, registration_id, seq, label, is_deposit, amount_centavos, currency, due_at, status, ' +
        'paid_at, paid_method, paid_reference, receipt_no, flagged_at, void_reason',
    )
    .in('registration_id', registrationIds)
    .order('seq', { ascending: true })
    .returns<ChargeRow[]>();
  if (error) throw error;

  for (const charge of data ?? []) {
    byRegistration.set(charge.registration_id, [
      ...(byRegistration.get(charge.registration_id) ?? []),
      charge,
    ]);
  }
  return byRegistration;
}

/**
 * The directory as a spreadsheet.
 *
 * Audited, like the roster export (`event.roster_exported`), and for a
 * stronger reason: a roster is one event's attendees, this is every email
 * address the business holds leaving in a single file. If that ever needs
 * explaining — to a person asking what happened to their data, or to
 * ourselves — the log should already say who took it and when.
 */
async function peopleCsv(
  query: Record<string, string | undefined>,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const supabase = await getSupabase();

  let builder = supabase.from('people_directory').select('*');
  const term = (query.q ?? '').trim();
  if (term) {
    const safe = filterSafe(term);
    builder = builder.or(`email.ilike.%${safe}%,full_name.ilike.%${safe}%`);
  }
  if (query.source && isSource(query.source)) {
    builder = builder.contains('sources', [query.source]);
  }

  const { data, error } = await builder
    .order('last_seen_at', { ascending: false })
    .returns<PersonRow[]>();
  if (error) throw error;

  const rows = data ?? [];
  const header = [
    'Email', 'Name', 'Has account', 'Sources', 'Course orders', 'Event registrations',
    'Events attending', 'Bookings', 'Enquiries', 'Lifetime paid', 'First seen', 'Last seen',
  ];
  const lines = rows.map((p) => [
    p.email,
    p.full_name ?? '',
    p.cognito_sub ? 'yes' : 'no',
    (p.sources ?? []).join(' | '),
    p.course_orders,
    p.event_registrations,
    p.events_attending,
    p.bookings,
    p.enquiries,
    (Number(p.lifetime_centavos ?? 0) / 100).toFixed(2),
    p.first_seen_at,
    p.last_seen_at,
  ]);

  const filters = [term && `q="${term}"`, query.source && `source=${query.source}`]
    .filter(Boolean)
    .join(', ');

  await recordAudit(actorFromEvent(event), {
    action: 'people.exported',
    targetTable: 'people_directory',
    note:
      `${rows.length} ${rows.length === 1 ? 'person' : 'people'}` +
      (filters ? ` (filtered: ${filters})` : ' (unfiltered — the whole directory)'),
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return csvResponse(`hilom-people-${stamp}.csv`, header, lines);
}

/**
 * The admin panel's work queues, defined once.
 *
 * Every queue on this platform exists in two places: the list endpoint that
 * shows the rows, and — since the dashboard — the count that tells an operator
 * the queue is there at all. Those two must agree. A dashboard saying "3
 * refunds owed" that links to a screen showing four is worse than no
 * dashboard, and the way that happens is two spellings of "owed" drifting
 * apart in two files.
 *
 * So the predicates live here as filters applied to a PostgREST query builder,
 * and both the list and the count apply the same one. Nothing in this file
 * chooses columns, ordering or limits — those differ legitimately between a
 * screen and a number.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isOutstanding, type ChargeStatus } from './event-ticketing.js';

/**
 * The subset of the PostgREST builder these predicates touch: `eq`/`gt`/`lt`/
 * `is`/`in`, each returning something with the same shape so calls chain.
 *
 * Left as `any` rather than a generic over the real `PostgrestFilterBuilder`:
 * that type is a recursive generic keyed on the full row shape, and a
 * predicate here is meant to compose onto two different builders — a
 * `select()` for a screen and a count-only `select()` for the dashboard —
 * with row types that legitimately differ. Threading a generic through to
 * satisfy both blew up into "Type instantiation is excessively deep" with no
 * behavioural upside; the filter methods a predicate calls are the same five
 * either way, and every call site below still gets the real return type from
 * supabase-js at the point it calls `.eq()` etc. directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueueFilter = (query: any) => any;

/**
 * Charge statuses that still owe money. Spelled as an array because a query
 * needs `.in()`, and checked against `isOutstanding` in the tests so this array
 * and that function cannot disagree about what "outstanding" means.
 */
export const OUTSTANDING_CHARGE_STATUSES: readonly ChargeStatus[] = ['scheduled', 'awaiting_payment'];

/** A facilitator application nobody has decided on yet. */
export const facilitatorsAwaitingReview: QueueFilter = (q) => q.eq('status', 'applied');

/** A client review nobody has moderated. Invisible on the site until they do. */
export const reviewsAwaitingModeration: QueueFilter = (q) => q.eq('status', 'pending');

/** A facilitator's event proposal nobody has approved or rejected (0048). */
export const eventsAwaitingReview: QueueFilter = (q) => q.eq('review_status', 'submitted');

/**
 * Money owed to a client and not yet sent. The same two-column ledger for
 * bookings (0014) and class registrations (0051), which is why one filter
 * serves both: owed is `refund_centavos > 0 and refunded_at is null`.
 */
export const refundOwed: QueueFilter = (q) => q.gt('refund_centavos', 0).is('refunded_at', null);

/** An order where the money landed and the enrolment did not. */
export const ordersNotFulfilled: QueueFilter = (q) => q.eq('status', 'paid_pending_enrollment');

/** An instalment past its due date and still unpaid. */
export const chargesOverdue =
  (now: Date): QueueFilter =>
  (q) =>
    q.in('status', OUTSTANDING_CHARGE_STATUSES).lt('due_at', now.toISOString());

/** Registration statuses that still hold a seat; a cancelled one owes nothing. */
const LIVE_REGISTRATION_STATUSES = ['pending_payment', 'confirmed', 'completed'];

export interface QueueCounts {
  facilitatorApplications: number;
  reviewsPending: number;
  eventProposals: number;
  classRefundsOwed: number;
  bookingRefundsOwed: number;
  overdueRegistrations: number;
  stuckOrders: number;
}

/** `select('id', { count: 'exact', head: true })` — a number, and no rows. */
async function countOf(supabase: SupabaseClient, table: string, filter: QueueFilter): Promise<number> {
  const { count, error } = await filter(supabase.from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count ?? 0;
}

/**
 * Registrations with at least one overdue instalment.
 *
 * Two queries rather than one because the overdue-ness lives on the charge and
 * the queue is counted in registrations — a registration three instalments
 * behind is one row on the Registrations screen, not three. The first read is
 * narrow on purpose: one uuid column over the overdue charges only.
 *
 * Cancelled and expired registrations are excluded, matching the screen: an
 * instalment against a seat nobody holds any more is not a payment anyone is
 * chasing.
 */
async function countOverdueRegistrations(supabase: SupabaseClient, now: Date): Promise<number> {
  const filtered: { returns<T>(): PromiseLike<{ data: T | null; error: unknown }> } = chargesOverdue(now)(
    supabase.from('registration_charges').select('registration_id'),
  );
  const { data, error } = await filtered.returns<{ registration_id: string }[]>();
  if (error) throw error;

  const ids = [...new Set((data ?? []).map((r) => r.registration_id))];
  if (ids.length === 0) return 0;

  const { count, error: regError } = await supabase
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .in('id', ids)
    .in('status', LIVE_REGISTRATION_STATUSES);
  if (regError) throw regError;
  return count ?? 0;
}

/** Every queue's depth, in one round of parallel count-only reads. */
export async function countQueues(supabase: SupabaseClient, now: Date): Promise<QueueCounts> {
  const [
    facilitatorApplications,
    reviewsPending,
    eventProposals,
    classRefundsOwed,
    bookingRefundsOwed,
    overdueRegistrations,
    stuckOrders,
  ] = await Promise.all([
    countOf(supabase, 'facilitators', facilitatorsAwaitingReview),
    countOf(supabase, 'facilitator_reviews', reviewsAwaitingModeration),
    countOf(supabase, 'events', eventsAwaitingReview),
    countOf(supabase, 'class_registrations', refundOwed),
    countOf(supabase, 'bookings', refundOwed),
    countOverdueRegistrations(supabase, now),
    countOf(supabase, 'orders', ordersNotFulfilled),
  ]);

  return {
    facilitatorApplications,
    reviewsPending,
    eventProposals,
    classRefundsOwed,
    bookingRefundsOwed,
    overdueRegistrations,
    stuckOrders,
  };
}

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

export interface RevenueLine {
  source: 'courses' | 'events' | 'sessions' | 'packages' | 'classes';
  label: string;
  centavos: number;
  count: number;
}

const sumAmounts = (rows: { amount: number | null }[]): number =>
  rows.reduce((acc, r) => acc + (r.amount ?? 0), 0);

async function collect(
  supabase: SupabaseClient,
  source: RevenueLine['source'],
  label: string,
  build: (client: SupabaseClient) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<RevenueLine> {
  const { data, error } = await build(supabase);
  if (error) throw error;
  const rows = (data ?? []) as { amount: number | null }[];
  return { source, label, centavos: sumAmounts(rows), count: rows.length };
}

/**
 * What came in over a window, split by what it was for.
 *
 * **Gross collected, not net.** Refunds are not subtracted anywhere on this
 * line. They are issued by hand on this platform, days after the fact, and
 * netting them off would make "money in this week" quietly change after the
 * week had ended. The two refund queues above are where refunds are accounted
 * for; this answers a different question — did anything sell.
 *
 * Sums are computed here over the window's rows rather than pushed into
 * Postgres because supabase-js has no `sum()`. Seven days of transactions is a
 * few dozen rows per source.
 */
export async function revenueSince(supabase: SupabaseClient, since: Date): Promise<RevenueLine[]> {
  const from = since.toISOString();

  return await Promise.all([
    // An order row exists only because a PayMongo payment landed — there is no
    // pending state to exclude.
    collect(supabase, 'courses', 'Courses', (c) =>
      c.from('orders').select('amount:amount_centavos').gte('created_at', from),
    ),
    // Instalments, by when they cleared rather than when the seat was taken: a
    // balance paid this week is this week's money even if the deposit was paid
    // in March.
    collect(supabase, 'events', 'Events', (c) =>
      c
        .from('registration_charges')
        .select('amount:amount_centavos')
        .eq('status', 'paid')
        .gte('paid_at', from),
    ),
    // A package-drawn session carries its share of an already-collected package
    // payment (0035), so counting it here as well would bill the same money
    // twice — hence `package_id is null`.
    collect(supabase, 'sessions', 'Sessions', (c) =>
      c
        .from('bookings')
        .select('amount:price_centavos')
        .is('package_id', null)
        .neq('status', 'pending_payment')
        .gte('created_at', from),
    ),
    collect(supabase, 'packages', 'Packages', (c) =>
      c
        .from('booking_packages')
        .select('amount:price_centavos')
        .neq('status', 'pending_payment')
        .gte('created_at', from),
    ),
    // `expired` is excluded rather than merely not-pending: an expired hold is
    // a seat nobody ever paid for, not a sale that later went wrong.
    collect(supabase, 'classes', 'Classes', (c) =>
      c
        .from('class_registrations')
        .select('amount:price_centavos')
        .in('status', ['confirmed', 'completed', 'cancelled'])
        .gte('created_at', from),
    ),
  ]);
}

/** Re-exported for the test that keeps `OUTSTANDING_CHARGE_STATUSES` honest. */
export { isOutstanding };

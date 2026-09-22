/**
 * Group classes (0049): the public half.
 *
 *   GET  /classes/{facilitatorSlug}          — what they teach, and when
 *   GET  /classes/session/{sessionId}        — one session, for the join page
 *   POST /classes/session/{sessionId}/join   — claim a seat and start checkout
 *   GET  /me/classes                         — the signed-in client's classes
 *
 * ## Why this is not `bookings.ts`
 *
 * A class seat and a 1:1 booking look similar and behave differently in the
 * one place that matters: concurrency. A booking races against the *calendar*
 * — the exclusion constraint in 0012 decides who gets 10:00 — while a class
 * seat races against a *count*, resolved by `claim_class_seat` under a row
 * lock. Putting both in one handler would mean one function with two
 * concurrency models, which is the shape mistakes hide in.
 *
 * ## The money rule is unchanged
 *
 * The registration row is written, pending, *before* PayMongo is called. A
 * failure creating the checkout session leaves a hold that lapses on its own;
 * no payment can exist without a row to attach it to. Same order as bookings,
 * course orders and event registrations, for the same reason.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, notFound, serverError, unauthorized, json } from '../lib/http.js';
import { requireUser, UnauthorizedError } from '../lib/auth.js';
import { createHostedCheckout } from '../lib/paymongo-checkout.js';
import { splitFee } from '../lib/booking-domain.js';
import { confirmClassSeat } from '../lib/class-fulfillment.js';
import {
  validateReview,
  reviewerLabel,
  isAttendanceReviewable,
  reviewConflictTarget,
  type ReviewSubject,
} from '../lib/reviews.js';

/**
 * How long a seat is held while someone pays.
 *
 * Twenty minutes, matching bookings. A QR payment in the Philippines routinely
 * takes several minutes — the number is set by how long a real payment takes,
 * not by how long a page is likely to stay open.
 */
const HOLD_MINUTES = 20;

/** Same local helper bookings.ts uses — 409 is not in http.ts's short list. */
const conflict = (message: string) => json(409, { error: message });

/** Columns safe to return on a public read. Note the absence of meeting_url. */
const CLASS_COLUMNS =
  'id, title, description, delivery_mode, location, duration_minutes, ' +
  'price_centavos, currency, min_joiners, max_joiners, is_active';

const SESSION_COLUMNS =
  'id, class_id, facilitator_id, starts_at, ends_at, price_centavos, currency, ' +
  'capacity, min_joiners, status';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    const supabase = await getSupabase();

    if (path.startsWith('/me/classes')) {
      if (method !== 'GET') return badRequest(`Unsupported method ${method}`);
      return await myClasses(supabase, event);
    }

    const registrationId = event.pathParameters?.registrationId;
    if (registrationId && path.endsWith('/review')) {
      return await classReview(supabase, event, registrationId, method);
    }

    const sessionId = event.pathParameters?.sessionId;
    if (sessionId) {
      if (method === 'GET') return await session(supabase, sessionId);
      if (method === 'POST' && path.endsWith('/join')) {
        return await join(supabase, event, sessionId);
      }
      return badRequest(`Unsupported route ${method} ${path}`);
    }

    const slug = event.pathParameters?.facilitatorSlug;
    if (slug && method === 'GET') return await listForFacilitator(supabase, slug);

    return badRequest(`Unsupported route ${method} ${path}`);
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    return serverError('classes', err);
  }
}

/**
 * Every active class a facilitator teaches, with its upcoming sessions.
 *
 * Past sessions are excluded rather than returned and filtered in the browser:
 * a class that has run weekly for a year has hundreds of them and none are
 * bookable.
 */
async function listForFacilitator(
  supabase: SupabaseClient,
  slug: string,
): Promise<APIGatewayProxyResultV2> {
  const { data: facilitator, error: facError } = await supabase
    .from('facilitators')
    .select('id, slug, display_name, status')
    .eq('slug', slug)
    .maybeSingle<{ id: string; slug: string; display_name: string; status: string }>();
  if (facError) throw facError;
  // Same indistinguishable-404 rule the rest of the marketplace follows: an
  // unpublished profile and a nonexistent one look identical from outside.
  if (!facilitator || facilitator.status !== 'published') return notFound('Not found');

  const { data: classes, error: classError } = await supabase
    .from('facilitator_classes')
    .select(CLASS_COLUMNS)
    .eq('facilitator_id', facilitator.id)
    .eq('is_active', true)
    .returns<Record<string, unknown>[]>();
  if (classError) throw classError;

  const rows = classes ?? [];
  // Same trimmed shape as the populated return below — the full row carries
  // the internal id and status, and neither belongs in a public response.
  const publicFacilitator = { slug: facilitator.slug, display_name: facilitator.display_name };
  if (rows.length === 0) return ok({ facilitator: publicFacilitator, classes: [] });

  const { data: sessions, error: sessionError } = await supabase
    .from('facilitator_class_sessions')
    .select(SESSION_COLUMNS)
    .in('class_id', rows.map((c) => c.id as string))
    .eq('status', 'scheduled')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .returns<Record<string, unknown>[]>();
  if (sessionError) throw sessionError;

  const taken = await seatsTaken(
    supabase,
    (sessions ?? []).map((s) => s.id as string),
  );

  const byClass = new Map<string, unknown[]>();
  for (const s of sessions ?? []) {
    const list = byClass.get(s.class_id as string) ?? [];
    const capacity = Number(s.capacity);
    const seats = taken.get(s.id as string) ?? 0;
    list.push({
      ...s,
      seatsTaken: seats,
      seatsLeft: Math.max(0, capacity - seats),
      // Stated rather than derived in the browser, so "full" means the same
      // thing on every surface that renders it.
      full: seats >= capacity,
      // The minimum is advisory (0049) — surfaced so a page can say "runs with
      // 3+", never so anything can cancel.
      meetsMinimum: seats >= Number(s.min_joiners),
    });
    byClass.set(s.class_id as string, list);
  }

  return ok({
    facilitator: publicFacilitator,
    classes: rows.map((c) => ({ ...c, sessions: byClass.get(c.id as string) ?? [] })),
  });
}

/** One session plus its class, for the page someone lands on from a link. */
async function session(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<APIGatewayProxyResultV2> {
  const { data, error } = await supabase
    .from('facilitator_class_sessions')
    .select(
      `${SESSION_COLUMNS}, facilitator_classes!inner(${CLASS_COLUMNS}), ` +
        'facilitators!inner(slug, display_name, photo_url, status)',
    )
    .eq('id', sessionId)
    .maybeSingle<Record<string, any>>();
  if (error) throw error;
  if (!data || data.facilitators?.status !== 'published') return notFound('Class not found');

  const taken = (await seatsTaken(supabase, [sessionId])).get(sessionId) ?? 0;
  const capacity = Number(data.capacity);

  return ok({
    session: {
      ...data,
      seatsTaken: taken,
      seatsLeft: Math.max(0, capacity - taken),
      full: taken >= capacity,
      meetsMinimum: taken >= Number(data.min_joiners),
    },
  });
}

/**
 * Claims a seat and starts checkout.
 *
 * The claim is a single `claim_class_seat` call rather than a read-then-write,
 * because capacity is a race: two people pressing Join on the last seat at the
 * same moment must not both get it, and only a row lock decides that. Every
 * refusal the function raises — full, already registered, started, cancelled —
 * comes back as a specific message rather than a generic failure, because each
 * one has a different thing the person should do next.
 */
async function join(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  sessionId: string,
): Promise<APIGatewayProxyResultV2> {
  const user = await requireUser(event);
  const body = parseBody(event);
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : null;

  const { data: row, error: readError } = await supabase
    .from('facilitator_class_sessions')
    .select(
      `${SESSION_COLUMNS}, facilitator_classes!inner(title), ` +
        'facilitators!inner(slug, display_name, platform_fee_bps, status)',
    )
    .eq('id', sessionId)
    .maybeSingle<Record<string, any>>();
  if (readError) throw readError;
  if (!row || row.facilitators?.status !== 'published') return notFound('Class not found');

  const name =
    [user.givenName, user.familyName].filter(Boolean).join(' ') ||
    (typeof body.name === 'string' ? body.name.trim() : '') ||
    null;

  const { data: claimed, error: claimError } = await supabase.rpc('claim_class_seat', {
    p_session_id: sessionId,
    p_client_email: user.email,
    p_client_sub: user.sub,
    p_client_name: name,
    p_client_notes: notes,
    p_hold_minutes: HOLD_MINUTES,
  });

  if (claimError) {
    const message = String(claimError.message ?? '');
    if (message.includes('class_full')) return conflict('That class just filled up.');
    if (message.includes('already_registered')) {
      return conflict('You already have a place in this class.');
    }
    if (message.includes('session_started')) return conflict('That class has already started.');
    if (message.includes('session_not_open')) return conflict('That class is no longer open.');
    if (message.includes('session_not_found')) return notFound('Class not found');
    throw claimError;
  }

  const registrationId = String(claimed);

  // The fee split, written now rather than at payment: what the facilitator is
  // owed must not move if their rate changes between joining and paying. Same
  // snapshot rule as bookings.
  const fee = splitFee(Number(row.price_centavos), Number(row.facilitators.platform_fee_bps));
  await supabase
    .from('class_registrations')
    .update({
      platform_fee_centavos: fee.platformFeeCentavos,
      facilitator_net_centavos: fee.facilitatorNetCentavos,
    })
    .eq('id', registrationId);

  // A free class is confirmed outright — there is nothing to pay and no reason
  // to send someone to a checkout for ₱0.
  if (fee.priceCentavos === 0) {
    // Through the shared path, so a free joiner gets the same confirmation
    // email a paying one does. It is the only message they will ever get --
    // there is no payment receipt behind it.
    const result = await confirmClassSeat(supabase, registrationId);
    return ok({ registrationId, free: true, status: result.status });
  }

  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';
  const title = String(row.facilitator_classes.title);

  let checkout;
  try {
    checkout = await createHostedCheckout({
      name: `${title} with ${row.facilitators.display_name}`,
      description: title,
      amountCentavos: fee.priceCentavos,
      currency: String(row.currency),
      billing: { email: user.email, name },
      // `kind` is what the webhook branches on — see paymongo-webhook.ts.
      metadata: {
        kind: 'class',
        class_registration_id: registrationId,
        buyer_email: user.email,
      },
      successUrl: `${origin}/booking/processing?class=${registrationId}`,
      cancelUrl: `${origin}/facilitators/${row.facilitators.slug}`,
    });
  } catch (err) {
    // Release the seat rather than holding it for twenty minutes over a
    // failure that had nothing to do with the person trying to join.
    await supabase
      .from('class_registrations')
      .delete()
      .eq('id', registrationId)
      .eq('status', 'pending_payment');
    return serverError('classes.join', err);
  }

  await supabase
    .from('class_registrations')
    .update({ paymongo_session_id: checkout.sessionId })
    .eq('id', registrationId);

  return ok({
    registrationId,
    free: false,
    checkoutUrl: checkout.checkoutUrl,
    amountCentavos: fee.priceCentavos,
    currency: String(row.currency),
    title,
    startsAt: String(row.starts_at),
  });
}

/**
 * The signed-in client's classes.
 *
 * `meeting_url` is released here and only here among the public reads, and
 * only for a confirmed registration — the same rule events follow for
 * `join_url` (0045). A pending row gets everything except the room.
 */
async function myClasses(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const user = await requireUser(event);

  const { data, error } = await supabase
    .from('class_registrations')
    .select(
      'id, status, seat_no, price_centavos, currency, created_at, ' +
        'facilitator_class_sessions!inner(id, starts_at, ends_at, status, meeting_url, ' +
        'facilitator_classes!inner(title, description, delivery_mode, location, duration_minutes), ' +
        'facilitators!inner(slug, display_name, photo_url))',
    )
    .ilike('client_email', user.email)
    .in('status', ['pending_payment', 'confirmed', 'completed'])
    .returns<Record<string, any>[]>();
  if (error) throw error;

  const rows = (data ?? []).map((r) => {
    const s = r.facilitator_class_sessions;
    return {
      ...r,
      facilitator_class_sessions: {
        ...s,
        meeting_url: r.status === 'confirmed' ? s.meeting_url : null,
      },
    };
  });

  rows.sort((a, b) =>
    String(a.facilitator_class_sessions?.starts_at ?? '').localeCompare(
      String(b.facilitator_class_sessions?.starts_at ?? ''),
    ),
  );

  return ok({ classes: rows });
}

/**
 * Live seat counts for a set of sessions, in one query.
 *
 * One query for every session rather than one per session: a facilitator with
 * a weekly class and three months on the calendar is a dozen sessions, and a
 * per-session count is the shape that quietly becomes N+1.
 *
 * Expired holds are excluded by status. A hold that has lapsed but not yet
 * been swept still reads as `pending_payment`, so this can overcount by the
 * number of abandoned checkouts in the last twenty minutes. That is deliberate
 * and it errs the safe way: it can only ever make a class look *fuller* than
 * it is, and `claim_class_seat` releases the lapsed rows before deciding, so
 * nobody is actually refused a seat that exists.
 */
async function seatsTaken(
  supabase: SupabaseClient,
  sessionIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sessionIds.length === 0) return counts;

  const { data, error } = await supabase
    .from('class_registrations')
    .select('session_id')
    .in('session_id', sessionIds)
    .in('status', ['pending_payment', 'confirmed'])
    .returns<{ session_id: string }[]>();
  if (error) throw error;

  for (const row of data ?? []) {
    counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
  }
  return counts;
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The client's review of a class they attended (0050).
 *
 *   GET /classes/registration/{registrationId}/review
 *   PUT /classes/registration/{registrationId}/review
 *
 * Same contract as the 1:1 review in bookings.ts, and deliberately so: the
 * rating lands on the same facilitator average, so the bar for leaving one has
 * to be the same. Ownership is proved by the email on the registration — a
 * review is a public statement about a named person and the right to make one
 * comes from having actually been there.
 */
async function classReview(
  supabase: SupabaseClient,
  event: APIGatewayProxyEventV2,
  registrationId: string,
  method: string,
): Promise<APIGatewayProxyResultV2> {
  const user = await requireUser(event);

  const { data: registration, error } = await supabase
    .from('class_registrations')
    .select(
      'id, facilitator_id, client_email, client_name, status, ' +
        'facilitator_class_sessions!inner(starts_at, ends_at)',
    )
    .eq('id', registrationId)
    .ilike('client_email', user.email)
    .maybeSingle<Record<string, any>>();
  if (error) throw error;
  // Indistinguishable from "no such registration", the same choice every other
  // owned-resource read in this codebase makes: a 403 here would confirm that
  // an id exists.
  if (!registration) return notFound('Not found');

  const session = registration.facilitator_class_sessions;
  const reviewable = isAttendanceReviewable(
    String(registration.status),
    session?.ends_at ?? null,
    String(session?.starts_at),
  );

  if (method === 'GET') {
    const { data, error: readError } = await supabase
      .from('facilitator_reviews')
      .select('id, rating, comment, status, created_at, updated_at')
      .eq('class_registration_id', registrationId)
      .maybeSingle();
    if (readError) throw readError;
    return ok({ review: data ?? null, reviewable });
  }

  if (method !== 'PUT') return badRequest(`Unsupported method ${method}`);

  if (!reviewable) {
    return badRequest(
      registration.status === 'confirmed'
        ? 'You can leave a review once the class has happened.'
        : 'Only a class you attended can be reviewed.',
    );
  }

  const input = validateReview(parseBody(event));
  const subject = { class_registration_id: registrationId } satisfies ReviewSubject;

  // Always back to `pending`, including on a revision of an already-approved
  // review — the new text has not been read by anyone.
  const { data, error: writeError } = await supabase
    .from('facilitator_reviews')
    .upsert(
      {
        ...subject,
        facilitator_id: registration.facilitator_id,
        rating: input.rating,
        comment: input.comment,
        client_label: reviewerLabel(registration.client_name),
        status: 'pending',
      },
      // One of 0050's three partial unique indexes. Without naming it, a
      // revision would insert a second review for the same seat.
      { onConflict: reviewConflictTarget(subject) },
    )
    .select('id, rating, comment, status, created_at')
    .maybeSingle();
  if (writeError) throw writeError;

  return ok({ review: data });
}

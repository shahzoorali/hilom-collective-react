/**
 * Cancelling one group-class occurrence.
 *
 * Extracted from `facilitator-portal.ts` (0049) so the admin panel's Classes
 * screen (docs/admin-dashboard-plan.md §5) can cancel a date through the exact
 * same path a facilitator uses, rather than a second implementation that could
 * quietly record a different refund figure or skip an attendee email. Two
 * definitions of what a client is owed is the failure mode this file exists to
 * rule out.
 *
 * The only thing that varies by caller is `cancelledBy`, stamped onto every
 * affected registration — `class_registrations.cancelled_by` already allows
 * `'client' | 'facilitator' | 'admin'` (0049), so this needed no migration.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendClassCancelled } from './booking-email.js';

/** The columns this file needs from a facilitator row, whichever caller loaded it. */
export interface ClassCancellationFacilitator {
  id: string;
  display_name: string;
  timezone: string;
}

interface CancelledSeat {
  id: string;
  price_centavos: number;
  currency: string | null;
  client_email: string | null;
  client_name: string | null;
}

export interface CancelClassSessionResult {
  cancelled: boolean;
  registrationsCancelled: number;
  /** What an admin has to action by hand. Named this rather than `refunded` because nothing here moved any money. */
  refundsOwed: number;
  refundTotalCentavos: number;
}

/**
 * Cancels one occurrence.
 *
 * Deliberately does **not** refund. Refunds on this platform are manual by
 * design — the same locked decision that governs course refunds and 1:1
 * cancellations — so this records the cancellation, frees the seats, and
 * reports how many people are owed money so that an admin can act on it. A
 * handler that quietly issued refunds would be the only automatic money
 * movement in the codebase.
 *
 * The `facilitator_id` filter on the session read is what makes this safe to
 * call from either caller unchanged: a facilitator passes their own row, so it
 * is also an ownership check; the admin caller looks up the session's actual
 * owner first (see admin-classes.ts), so the same filter is a no-op there but
 * costs nothing to keep — one query, one code path, either way.
 *
 * Returns `null` when there is no such scheduled session — not found, or
 * already cancelled — so the caller can shape its own 404.
 */
export async function cancelClassSession(
  supabase: SupabaseClient,
  facilitator: ClassCancellationFacilitator,
  sessionId: string,
  reason: string | null,
  cancelledBy: 'facilitator' | 'admin',
): Promise<CancelClassSessionResult | null> {
  const { data, error } = await supabase
    .from('facilitator_class_sessions')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
    })
    .eq('id', sessionId)
    .eq('facilitator_id', facilitator.id)
    .eq('status', 'scheduled')
    .select('id, starts_at, price_centavos')
    .maybeSingle<{ id: string; starts_at: string; price_centavos: number }>();
  if (error) throw error;
  if (!data) return null;

  // Two writes, split by what the person actually held rather than by price.
  //
  // Every seat on a session was sold at the same price — claim_class_seat
  // stamps the session's price onto each one (0049) — so "was this paid for"
  // is a property of the session, not of the row. That makes the split clean:
  // confirmed seats are the people who were coming, pending ones are people
  // who started a checkout and never finished.
  //
  // `refund_centavos` is set here because this is the only moment the amount
  // is unambiguous, and setting it is what puts the row in the admin refund
  // queue at all — that queue is `refund_centavos > 0 and refunded_at is null`
  // (0051). A free class leaves it null: "nothing was charged" and "a refund
  // of zero" are different facts and the queue must not show the first.
  const sessionPrice = Number(data.price_centavos ?? 0);

  const { data: confirmedSeats, error: paidError } = await supabase
    .from('class_registrations')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
      refund_centavos: sessionPrice > 0 ? sessionPrice : null,
    })
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')
    .select('id, price_centavos, currency, client_email, client_name')
    .returns<CancelledSeat[]>();
  if (paidError) throw paidError;

  // Holds that never completed payment. Cancelled so the seat is not left
  // dangling, owed nothing, and deliberately not emailed — a cancellation
  // notice would be the first they ever heard about any of it.
  const { error: regError } = await supabase
    .from('class_registrations')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
    })
    .eq('session_id', sessionId)
    .eq('status', 'pending_payment');
  if (regError) throw regError;

  const affected = confirmedSeats ?? [];
  // Owed only when the class was actually paid for.
  const owed = sessionPrice > 0 ? affected : [];

  // Tell everyone, and do not let a failed send undo a cancellation that has
  // already happened. Best-effort throughout this codebase for that reason:
  // the class is off either way, and a bounced address must not leave the
  // session half-cancelled.
  //
  // Only people who still had a live place are written to. A lapsed hold is
  // someone who considered coming and never paid; mailing them about a
  // cancellation would be the first they had heard of any of it.
  //
  // Sequential rather than Promise.all: a class is at most a few dozen seats,
  // and SES has a per-second send quota that a burst can trip.
  const cls = await supabase
    .from('facilitator_class_sessions')
    .select('facilitator_classes(title)')
    .eq('id', sessionId)
    .maybeSingle<{ facilitator_classes: { title: string } | null }>();
  const className = cls.data?.facilitator_classes?.title ?? 'your class';

  for (const seat of affected) {
    if (!seat.client_email) continue;
    try {
      await sendClassCancelled({
        to: seat.client_email,
        clientName: seat.client_name,
        className,
        facilitatorName: facilitator.display_name,
        startsAt: data.starts_at,
        timezone: facilitator.timezone,
        refundCentavos: Number(seat.price_centavos ?? 0),
        currency: String(seat.currency ?? 'PHP'),
        reason,
      });
    } catch (err) {
      console.error('[class-cancellation] cancellation email failed', {
        registrationId: seat.id,
        err,
      });
    }
  }

  return {
    cancelled: true,
    registrationsCancelled: affected.length,
    refundsOwed: owed.length,
    refundTotalCentavos: owed.reduce((sum, r) => sum + Number(r.price_centavos), 0),
  };
}

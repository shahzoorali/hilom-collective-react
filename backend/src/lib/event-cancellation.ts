/**
 * Cancelling one event date (0054, step 3).
 *
 * Mirrors `class-cancellation.ts` exactly on purpose — same shape, same
 * reasons — so an admin and a facilitator cancelling a date get the identical
 * outcome, and so a second implementation cannot quietly compute a different
 * refund figure. The only thing that varies by caller is `cancelledBy`.
 *
 * ## Full refund, not the §III tiers
 *
 * `admin-registrations.ts`'s per-registration `cancel()` runs every refund
 * through `assessRefund` — the notice-period tiers from the Facilitator
 * Agreement, which exist for a *registrant's own* decision to withdraw. That
 * is the wrong rule here: nobody who bought a seat did anything wrong when the
 * host called off the date, and applying the notice-tier haircut to them would
 * quietly under-refund a client on Hilom's own decision. So this refunds
 * whatever was actually paid, in full — the same rule `class-cancellation.ts`
 * already uses for a cancelled class session.
 *
 * ## Deliberately no refund
 *
 * Same locked decision as everywhere else on this platform: refunds are
 * manual. This records what each registrant is owed and reports it; an admin
 * sends the money and marks it via the registration's own
 * `refund_centavos`/`refunded_at` pair (0016), the same queue a per-registration
 * cancellation already feeds.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { paidCentavos } from './event-ticketing.js';
import { sendRegistrationCancelled } from './registration-email.js';
import { chargesFor, type ChargeRow } from './event-roster.js';

interface CancelledRegistration {
  id: string;
  buyer_email: string;
  registrant_name: string;
  currency: string;
  total_centavos: number;
}

export interface CancelEventDateResult {
  cancelled: boolean;
  title: string;
  registrationsCancelled: number;
  /** What an admin has to action by hand. Named this rather than `refunded` because nothing here moved any money. */
  refundsOwed: number;
  refundTotalCentavos: number;
  currency: string;
}

/**
 * Cancels one date.
 *
 * `status: 'draft'` alongside `cancelled_at` is what actually stops a sale —
 * `claim_event_seat()` (0016) refuses any event whose `status <> 'published'`
 * — and it is set in the same update as the cancellation stamp so there is no
 * window where the row reads cancelled but is still buyable.
 *
 * The `facilitator_id` filter on the read is what makes this safe to call from
 * either caller unchanged: a facilitator passes their own id, so it is also an
 * ownership check; the admin caller passes `null`, so the filter is skipped —
 * one code path either way. See the identical note in `cancelClassSession`.
 *
 * Returns `null` for no such live event — not found, or already cancelled —
 * so the caller shapes its own 404.
 */
export async function cancelEventDate(
  supabase: SupabaseClient,
  facilitatorId: string | null,
  eventId: string,
  reason: string,
  cancelledBy: 'facilitator' | 'admin',
): Promise<CancelEventDateResult | null> {
  let query = supabase
    .from('events')
    .update({ status: 'draft', cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq('id', eventId)
    .is('cancelled_at', null);
  if (facilitatorId) query = query.eq('facilitator_id', facilitatorId);

  const { data: event, error } = await query
    .select('id, title, starts_at, ends_at, location, venue_details, format, currency')
    .maybeSingle<{
      id: string;
      title: string;
      starts_at: string;
      ends_at: string | null;
      location: string | null;
      venue_details: string | null;
      format: string | null;
      currency: string;
    }>();
  if (error) throw error;
  if (!event) return null;

  const now = new Date().toISOString();

  // Confirmed registrants: the people who were actually coming, and who are
  // owed whatever they paid.
  const { data: confirmed, error: confirmedError } = await supabase
    .from('event_registrations')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
      hold_expires_at: null,
      flagged_at: null,
      flag_reason: null,
    })
    .eq('event_id', eventId)
    .eq('status', 'confirmed')
    .select('id, buyer_email, registrant_name, currency, total_centavos')
    .returns<CancelledRegistration[]>();
  if (confirmedError) throw confirmedError;

  // Holds that never completed payment. Cancelled so the seat is not left
  // dangling, owed nothing, and deliberately not emailed — a cancellation
  // notice would be the first they ever heard of any of this.
  const { error: pendingError } = await supabase
    .from('event_registrations')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: cancelledBy,
      cancellation_reason: reason,
      hold_expires_at: null,
    })
    .eq('event_id', eventId)
    .eq('status', 'pending_payment');
  if (pendingError) throw pendingError;

  // Every charge on this date that is still payable stops being payable —
  // pending holds included. Voiding only the confirmed registrants' charges
  // left a pending buyer's deposit `awaiting_payment` with a live checkout
  // link, so finishing that checkout after the cancellation took money for a
  // date that no longer exists. Paid charges are left exactly as they are:
  // that money was received, and erasing the record of it is not the same as
  // returning it. A payment that lands on a voided charge anyway is recorded
  // and logged by applyChargePayment for an admin to refund.
  const { error: voidError } = await supabase
    .from('registration_charges')
    .update({ status: 'void', voided_at: now, void_reason: 'event_cancelled', flagged_at: null })
    .eq('event_id', eventId)
    .in('status', ['scheduled', 'awaiting_payment']);
  if (voidError) throw voidError;

  const affected = confirmed ?? [];
  if (affected.length === 0) {
    return { cancelled: true, title: event.title, registrationsCancelled: 0, refundsOwed: 0, refundTotalCentavos: 0, currency: event.currency };
  }

  const byRegistration = await chargesFor(supabase, affected.map((r) => r.id));

  // Whatever was actually paid, refunded in full — see the note at the top of
  // this file on why the §III notice tiers do not apply here.
  const owed = affected.map((r) => ({
    ...r,
    paid: paidCentavos(byRegistration.get(r.id) ?? []),
  }));

  // Refund is recorded on every confirmed registration, paid or free — a free
  // seat correctly gets `refund_centavos: null`, which is what keeps it out of
  // the refund queue (0016's predicate is `refund_centavos > 0`).
  for (const r of owed) {
    const { error: refundError } = await supabase
      .from('event_registrations')
      .update({ refund_centavos: r.paid > 0 ? r.paid : null })
      .eq('id', r.id);
    if (refundError) throw refundError;
  }

  // Tell everyone. Best-effort, like every other notification in this
  // codebase: the date is off either way, and a bounced address must not
  // leave the cancellation half-done. Sequential, not Promise.all — SES has a
  // per-second quota a burst of a few dozen sends can trip.
  for (const r of owed) {
    if (!r.buyer_email) continue;
    try {
      await sendRegistrationCancelled({
        registrationId: r.id,
        buyerEmail: r.buyer_email,
        registrantName: r.registrant_name,
        event: event as never,
        registration: r as never,
        charges: (byRegistration.get(r.id) ?? []) as ChargeRow[],
        refundCentavos: r.paid > 0 ? r.paid : null,
        reason: `This date was cancelled. ${reason}`.trim(),
      });
    } catch (err) {
      console.error('[event-cancellation] cancellation email failed', { registrationId: r.id, err });
    }
  }

  const refundable = owed.filter((r) => r.paid > 0);

  return {
    cancelled: true,
    title: event.title,
    registrationsCancelled: affected.length,
    refundsOwed: refundable.length,
    refundTotalCentavos: refundable.reduce((sum, r) => sum + r.paid, 0),
    currency: event.currency,
  };
}

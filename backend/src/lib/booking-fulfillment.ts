/**
 * Turns a paid booking into a confirmed one.
 *
 * The booking equivalent of `fulfillment.ts`, and it keeps the same invariant
 * the course flow established: the row exists, holding its slot, *before* the
 * buyer is sent to PayMongo. So this function never creates anything — it flips
 * a row that is already there. "Paid but not booked" is therefore not a state
 * this system can reach; the worst case is "paid and still pending_payment",
 * which is visible, queryable and retryable.
 *
 * The fee split, price and meeting URL are not computed here. They were
 * snapshotted onto the row when the hold was taken, so that what the client was
 * quoted is what they are charged and what the facilitator is owed, even if the
 * service is edited or the fee tier renegotiated in between.
 */
import { getSupabase } from './supabase.js';
import { sendBookingConfirmed } from './booking-email.js';
import type { BookingStatus } from './booking-domain.js';

export interface ConfirmResult {
  bookingId: string;
  status: BookingStatus;
  alreadyConfirmed: boolean;
}

/**
 * The row shape confirmation needs, with the facilitator and service joined.
 * PostgREST returns embedded relations as nested objects.
 */
interface BookingWithRelations {
  id: string;
  status: BookingStatus;
  starts_at: string;
  client_email: string;
  client_name: string | null;
  price_centavos: number;
  meeting_url: string | null;
  facilitators: { email: string; display_name: string; timezone: string } | null;
  facilitator_services: { title: string } | null;
}

const JOINED =
  'id, status, starts_at, client_email, client_name, price_centavos, meeting_url, facilitators(email, display_name, timezone), facilitator_services(title)';

/**
 * Marks a booking confirmed and notifies both parties.
 *
 * Idempotent on purpose: PayMongo delivers webhooks at least once, and the two
 * fulfillable event types mean a single hosted-checkout payment fires two
 * events. Re-confirming an already-confirmed booking is a no-op that returns
 * cleanly rather than sending a second pair of emails.
 */
export async function confirmBooking(bookingId: string, paymentId?: string): Promise<ConfirmResult> {
  const supabase = await getSupabase();

  const { data: booking, error } = await supabase
    .from('bookings')
    .select(JOINED)
    .eq('id', bookingId)
    .maybeSingle<BookingWithRelations>();

  if (error) throw error;
  if (!booking) throw new Error(`Booking ${bookingId} not found`);

  if (booking.status === 'confirmed') {
    return { bookingId, status: 'confirmed', alreadyConfirmed: true };
  }

  // A booking cancelled before the webhook landed must not be resurrected by
  // it. The payment id is still recorded so the money is traceable to a row,
  // and the refund is then an ordinary admin cancellation case.
  if (booking.status !== 'pending_payment') {
    console.warn('[booking-fulfillment] payment arrived for a non-pending booking', {
      bookingId,
      status: booking.status,
    });
    if (paymentId) {
      await supabase.from('bookings').update({ paymongo_payment_id: paymentId }).eq('id', bookingId);
    }
    return { bookingId, status: booking.status, alreadyConfirmed: false };
  }

  const patch: Record<string, unknown> = {
    status: 'confirmed',
    // The slot is now permanently held; nothing should reclaim it.
    hold_expires_at: null,
    error_detail: null,
  };
  if (paymentId) patch.paymongo_payment_id = paymentId;

  const { data: claimed, error: updateError } = await supabase
    .from('bookings')
    .update(patch)
    .eq('id', bookingId)
    // Guard against two concurrent webhook deliveries both passing the status
    // check above: only one update matches a still-pending row.
    .eq('status', 'pending_payment')
    // The `.select()` is what makes that guard real. Without it the filter
    // still narrows the write, but a delivery that matched *zero* rows is
    // indistinguishable from one that matched — no error is raised either way —
    // so both deliveries would fall through and email the client and the
    // facilitator a second confirmation for the same session.
    .select('id')
    .maybeSingle<{ id: string }>();

  if (updateError) {
    await supabase
      .from('bookings')
      .update({ error_detail: updateError.message })
      .eq('id', bookingId);
    throw updateError;
  }

  // Lost the race: a concurrent delivery confirmed this booking (and sent the
  // emails) between the status read above and this write.
  if (!claimed) {
    return { bookingId, status: 'confirmed', alreadyConfirmed: true };
  }

  const facilitator = booking.facilitators;
  const service = booking.facilitator_services;

  if (facilitator && service) {
    await sendBookingConfirmed({
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: facilitator.email,
      facilitatorName: facilitator.display_name,
      facilitatorTimezone: facilitator.timezone,
      serviceTitle: service.title,
      startsAt: booking.starts_at,
      meetingUrl: booking.meeting_url,
      isFree: booking.price_centavos === 0,
    });
  } else {
    // Not fatal — the booking is confirmed either way, and a missing join here
    // means a data problem worth seeing rather than a reason to fail the call.
    console.warn('[booking-fulfillment] confirmed without notifying: relations missing', { bookingId });
  }

  return { bookingId, status: 'confirmed', alreadyConfirmed: false };
}

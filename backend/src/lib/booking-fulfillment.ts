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
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabase.js';
import { sendBookingConfirmed, sendMeetingLinkFailed } from './booking-email.js';
import {
  createCalendarEvent,
  createMeeting,
  deleteCalendarEvent,
  deleteMeeting,
  isProvider,
  updateCalendarEvent,
  updateMeetingTime,
  type Provider,
} from './integrations.js';
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
  ends_at: string;
  client_email: string;
  client_name: string | null;
  client_timezone: string | null;
  client_notes: string | null;
  price_centavos: number;
  meeting_url: string | null;
  facilitators: { id: string; email: string; display_name: string; timezone: string } | null;
  facilitator_services: {
    title: string;
    duration_minutes: number;
    meeting_provider: string;
  } | null;
}

const JOINED =
  'id, status, starts_at, ends_at, client_email, client_name, client_timezone, client_notes, price_centavos, meeting_url, ' +
  'facilitators(id, email, display_name, timezone), ' +
  'facilitator_services(title, duration_minutes, meeting_provider)';

/** The Calendar event's description: who it's with, and how to join. */
function describeBookingForCalendar(
  booking: { client_name: string | null; client_email: string; client_notes: string | null },
  meetingUrl: string | null,
): string {
  const lines = [`With ${booking.client_name ?? booking.client_email}.`];
  if (meetingUrl) lines.push(`Join: ${meetingUrl}`);
  if (booking.client_notes) lines.push(`Notes: ${booking.client_notes}`);
  return lines.join('\n');
}

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

  // The meeting link. `booking.meeting_url` was snapshotted from the service at
  // insert time — for a 'manual' service that is the link; for an integrated
  // one it is the backup, used only if creation below fails.
  let meetingUrl = booking.meeting_url;
  let linkFailed = false;

  if (facilitator && service && isProvider(service.meeting_provider)) {
    const provider = service.meeting_provider as Provider;
    try {
      const meeting = await createMeeting(supabase, facilitator.id, provider, {
        title: service.title,
        startsAt: new Date(booking.starts_at),
        durationMinutes: service.duration_minutes,
        timezone: facilitator.timezone,
      });
      meetingUrl = meeting.url;
      await supabase
        .from('bookings')
        .update({
          meeting_url: meeting.url,
          meeting_provider: provider,
          meeting_external_id: meeting.externalId,
        })
        .eq('id', bookingId);
    } catch (err) {
      // The rule the whole booking flow is built on: recording the money and
      // confirming the slot must not depend on a third party being up. So the
      // booking stays confirmed, and the fallback chain is:
      //   1. the service's backup meeting_url, if one was set
      //   2. otherwise: no link in the client email, and the facilitator is
      //      told to send one.
      linkFailed = !booking.meeting_url;
      await supabase
        .from('bookings')
        .update({
          meeting_provider: provider,
          error_detail: `meeting link creation failed: ${
            err instanceof Error ? err.message.slice(0, 300) : String(err)
          }`,
        })
        .eq('id', bookingId);
      console.error('[booking-fulfillment] meeting link creation failed', {
        bookingId,
        provider,
        fallbackUsed: Boolean(booking.meeting_url),
      });
    }
  }

  // Calendar sync is independent of the meeting-link block above: a
  // facilitator can take Zoom or manual-link bookings and still want them on
  // their Google Calendar, so this runs whenever Google is connected at all,
  // not only when the service's own meeting_provider is 'google_meet'.
  if (facilitator) {
    try {
      const { eventId } = await createCalendarEvent(supabase, facilitator.id, {
        title: service?.title ?? 'Hilom session',
        description: describeBookingForCalendar(booking, meetingUrl),
        startsAt: new Date(booking.starts_at),
        durationMinutes: service?.duration_minutes ?? 60,
        timezone: facilitator.timezone,
        joinUrl: meetingUrl,
      });
      await supabase.from('bookings').update({ calendar_event_id: eventId }).eq('id', bookingId);
    } catch (err) {
      // Not connected, or a Google hiccup — logged only. A booking must never
      // fail, and a missing calendar entry is not visible to the client.
      console.error('[booking-fulfillment] calendar sync failed (non-blocking)', {
        bookingId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (facilitator && service) {
    await sendBookingConfirmed({
      clientEmail: booking.client_email,
      clientName: booking.client_name,
      facilitatorEmail: facilitator.email,
      facilitatorName: facilitator.display_name,
      facilitatorTimezone: facilitator.timezone,
      clientTimezone: booking.client_timezone,
      serviceTitle: service.title,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      bookingId,
      meetingUrl,
      isFree: booking.price_centavos === 0,
    });

    if (linkFailed) {
      // Sent in addition to the confirmation, not instead of it: the client
      // has a confirmed session, the facilitator needs to know it has no link.
      await sendMeetingLinkFailed({
        facilitatorEmail: facilitator.email,
        facilitatorName: facilitator.display_name,
        facilitatorTimezone: facilitator.timezone,
        clientName: booking.client_name ?? booking.client_email,
        clientTimezone: booking.client_timezone,
        serviceTitle: service.title,
        startsAt: booking.starts_at,
      }).catch((err: unknown) => {
        console.error('[booking-fulfillment] could not alert facilitator about missing link', {
          bookingId,
          err,
        });
      });
    }
  } else {
    // Not fatal — the booking is confirmed either way, and a missing join here
    // means a data problem worth seeing rather than a reason to fail the call.
    console.warn('[booking-fulfillment] confirmed without notifying: relations missing', { bookingId });
  }

  return { bookingId, status: 'confirmed', alreadyConfirmed: false };
}

/**
 * Keeps a booking's provider-hosted meeting in step after the booking moved or
 * was cancelled.
 *
 * Only Zoom has anything to do: a scheduled Zoom meeting carries a start time,
 * so a reschedule has to PATCH it and a cancellation should DELETE it. A Google
 * Meet space has no time and no lifecycle, so both are no-ops there.
 *
 * **Best-effort by contract.** The booking's own state change has already
 * happened and been emailed by the time this runs. A stale or orphaned Zoom
 * meeting is untidy, not broken — the join URL still resolves, and the client
 * always has the authoritative time from their email. So every failure here is
 * logged and swallowed; this never throws to the caller and never blocks a
 * reschedule or a cancellation.
 */
export async function syncBookingMeeting(
  supabase: SupabaseClient,
  bookingId: string,
  change: 'rescheduled' | 'cancelled',
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select(
        'facilitator_id, meeting_provider, meeting_external_id, calendar_event_id, starts_at, ' +
          'client_name, client_email, client_notes, meeting_url, ' +
          'facilitator_services(title, duration_minutes), facilitators(timezone)',
      )
      .eq('id', bookingId)
      .maybeSingle<{
        facilitator_id: string;
        meeting_provider: string | null;
        meeting_external_id: string | null;
        calendar_event_id: string | null;
        starts_at: string;
        client_name: string | null;
        client_email: string;
        client_notes: string | null;
        meeting_url: string | null;
        facilitator_services: { title: string; duration_minutes: number } | null;
        facilitators: { timezone: string } | null;
      }>();

    if (error) throw error;
    if (!data) return;

    const durationMinutes = data.facilitator_services?.duration_minutes ?? 60;
    const timezone = data.facilitators?.timezone ?? 'Asia/Manila';

    // Each provider's sync is independent — a Zoom failure must not skip the
    // Calendar sync, or vice versa.
    if (data.meeting_external_id && isProvider(data.meeting_provider ?? '')) {
      const provider = data.meeting_provider as Provider;
      try {
        if (change === 'cancelled') {
          await deleteMeeting(supabase, data.facilitator_id, provider, data.meeting_external_id);
        } else {
          await updateMeetingTime(supabase, data.facilitator_id, provider, data.meeting_external_id, {
            title: '',
            startsAt: new Date(data.starts_at),
            durationMinutes,
            timezone,
          });
        }
      } catch (err) {
        console.error('[booking-fulfillment] meeting sync failed (non-blocking)', {
          bookingId,
          change,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (data.calendar_event_id) {
      try {
        if (change === 'cancelled') {
          await deleteCalendarEvent(supabase, data.facilitator_id, data.calendar_event_id);
        } else {
          await updateCalendarEvent(supabase, data.facilitator_id, data.calendar_event_id, {
            title: data.facilitator_services?.title ?? 'Hilom session',
            description: describeBookingForCalendar(
              { client_name: data.client_name, client_email: data.client_email, client_notes: data.client_notes },
              data.meeting_url,
            ),
            startsAt: new Date(data.starts_at),
            durationMinutes,
            timezone,
            joinUrl: data.meeting_url,
          });
        }
      } catch (err) {
        console.error('[booking-fulfillment] calendar sync failed (non-blocking)', {
          bookingId,
          change,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    console.error('[booking-fulfillment] meeting sync failed (non-blocking)', {
      bookingId,
      change,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Confirming a seat in a group class (0049), in one place.
 *
 * Three things confirm a seat: joining a free class (no checkout to wait for),
 * the PayMongo webhook when a paid one clears, and the retry consumer when
 * that webhook failed the first time. Each had its own copy of the same two-
 * line update, which is how all three ended up sending no confirmation email
 * -- there was no single place to add one, so it was added to none of them.
 *
 * Same shape as `confirmBooking` and `confirmPackage`, and for the same
 * reason: whatever "confirmed" has to mean, it means it once.
 *
 * ## Idempotent by construction
 *
 * The update is filtered on `pending_payment`, so a second call matches
 * nothing and reports `already_confirmed` without re-sending the email. That
 * matters because a single hosted-checkout payment fires two fulfillable
 * events, and because the retry consumer can race the webhook it is retrying
 * for. Confirming twice must not email twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendClassJoined } from './booking-email.js';

export interface ClassConfirmResult {
  status: 'confirmed' | 'already_confirmed';
  registrationId: string;
}

/**
 * Moves a held seat to confirmed and tells the person.
 *
 * The email is best-effort and deliberately last. A send that fails must not
 * roll back a confirmation -- the seat is theirs and the money has moved --
 * and it must not throw into the webhook, where a rejection means PayMongo
 * retries a payment that has already been fulfilled.
 */
export async function confirmClassSeat(
  supabase: SupabaseClient,
  registrationId: string,
  paymentId?: string | null,
): Promise<ClassConfirmResult> {
  const patch: Record<string, unknown> = { status: 'confirmed', hold_expires_at: null };
  // Only stamped when there was a payment. A free class has no payment id, and
  // writing null over an existing one would lose the reference.
  if (paymentId) patch.paymongo_payment_id = paymentId;

  const { data: confirmed, error } = await supabase
    .from('class_registrations')
    .update(patch)
    .eq('id', registrationId)
    .eq('status', 'pending_payment')
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw error;

  if (!confirmed) return { status: 'already_confirmed', registrationId };

  await notifyJoined(supabase, registrationId);
  return { status: 'confirmed', registrationId };
}

/**
 * Loads everything the confirmation email needs and sends it.
 *
 * Read after the update rather than before it, so the row it describes is the
 * confirmed one -- and so this cannot release a joining link for a seat that
 * turned out to be already confirmed by someone else's call.
 */
async function notifyJoined(supabase: SupabaseClient, registrationId: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('class_registrations')
      .select(
        'client_email, client_name, price_centavos, currency, ' +
          'facilitator_class_sessions!inner(starts_at, meeting_url, ' +
          'facilitator_classes!inner(title, description, delivery_mode, location, duration_minutes), ' +
          'facilitators!inner(display_name, short_name, timezone))',
      )
      .eq('id', registrationId)
      .maybeSingle<Record<string, any>>();
    if (error) throw error;
    if (!data?.client_email) return;

    const session = data.facilitator_class_sessions;
    const cls = session?.facilitator_classes;
    const facilitator = session?.facilitators;
    if (!session || !cls) return;

    await sendClassJoined({
      to: data.client_email,
      clientName: data.client_name ?? null,
      className: cls.title,
      classDescription: cls.description ?? null,
      facilitatorName: facilitator?.short_name || facilitator?.display_name || 'your facilitator',
      startsAt: session.starts_at,
      durationMinutes: Number(cls.duration_minutes ?? 60),
      timezone: facilitator?.timezone || 'Asia/Manila',
      deliveryMode: String(cls.delivery_mode ?? 'online'),
      location: cls.location ?? null,
      // The session's link, not the class's: a session snapshots it at
      // scheduling time so that editing the class later cannot redirect a
      // class people are already booked onto.
      meetingUrl: session.meeting_url ?? null,
      pricePaidCentavos: Number(data.price_centavos ?? 0),
      currency: String(data.currency ?? 'PHP'),
    });
  } catch (err) {
    console.error('[class-fulfillment] joined email failed', { registrationId, err });
  }
}

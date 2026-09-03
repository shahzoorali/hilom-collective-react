/**
 * EventBridge-scheduled housekeeping for bookings (see `BookingSweepRule` in
 * the CDK stack — runs every 5 minutes, alongside the publish sweep).
 *
 * Three jobs, all of which exist because the database cannot do them itself:
 *
 *  1. **Release lapsed holds.** A `pending_payment` row occupies its slot via
 *     the `bookings_no_overlap` exclusion constraint, and that constraint
 *     cannot read `hold_expires_at` — it sees a live booking and blocks. So an
 *     abandoned checkout would sterilise a slot indefinitely. `POST /bookings`
 *     also clears lapsed holds inline for the facilitator being booked, which
 *     covers the common case immediately; this sweep is what handles the
 *     facilitator nobody happens to be booking right now.
 *
 *  2. **Complete past sessions.** `confirmed` means "on both calendars";
 *     `completed` means "delivered, and now payable". Nothing else moves a
 *     booking across that line, and payout batches read `completed`, so
 *     without this nobody would ever be paid.
 *
 *  3. **Remind both parties** before a session starts. A booking made three
 *     weeks out otherwise got one email at purchase and nothing since, which
 *     is the largest avoidable cause of a no-show — and a no-show still bills
 *     the client and still pays the facilitator, so nobody involved is happy
 *     about it.
 *
 * Idempotent by construction — every operation is keyed on a condition that
 * stops being true once applied, so running twice changes nothing the second
 * time. For reminders that condition is `reminder_sent_at`, which is claimed
 * before the email goes out rather than recorded after it; see the note on
 * sendDueReminders for why that ordering is the one that matters.
 */
import { getSupabase } from '../lib/supabase.js';
import { sendBookingReminder } from '../lib/booking-email.js';

/**
 * How long after a session ends before it counts as delivered.
 *
 * Not zero: it gives a facilitator a short window to mark a no-show while the
 * booking is still `confirmed`, rather than racing the sweep for it. Both
 * statuses are payable, so this only affects which label the session carries.
 */
const COMPLETION_GRACE_MINUTES = 30;

async function releaseExpiredHolds(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .delete()
    .eq('status', 'pending_payment')
    .lt('hold_expires_at', now.toISOString())
    .select('id');

  if (error) throw error;
  return (data ?? []).length;
}

async function completePastSessions(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const cutoff = new Date(now.getTime() - COMPLETION_GRACE_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'completed' })
    .eq('status', 'confirmed')
    .lt('ends_at', cutoff)
    .select('id');

  if (error) throw error;
  return (data ?? []).length;
}

/** How far ahead of a session its reminder goes out. */
const REMINDER_LEAD_HOURS = 24;

/**
 * Someone who booked minutes ago does not need reminding that they booked.
 * Without this, a session booked for this evening would get a "coming up"
 * email seconds after its confirmation.
 */
const REMINDER_MIN_AGE_MINUTES = 120;

/**
 * The row a reminder needs, with both parties joined.
 */
interface ReminderRow {
  id: string;
  starts_at: string;
  client_email: string;
  client_name: string | null;
  client_timezone: string | null;
  intake_completed_at: string | null;
  price_centavos: number;
  meeting_url: string | null;
  facilitators: { email: string; display_name: string; timezone: string } | null;
  facilitator_services: { title: string; intake_questions?: unknown[] } | null;
}

/**
 * Emails both parties about sessions starting within the lead window.
 *
 * Ordering is deliberate: each booking is *claimed* — `reminder_sent_at`
 * stamped, conditional on it still being null — and only then emailed. Two
 * overlapping sweep invocations therefore cannot both remind the same person,
 * because only one of them wins the stamp. The alternative ordering (send,
 * then record) duplicates every reminder the moment two invocations overlap,
 * which for a 5-minute schedule is a matter of when, not if.
 *
 * The stamp is rolled back if the send fails, so a transient SES error means
 * the next sweep retries rather than the reminder being silently lost. That
 * leaves one narrow window — a crash between sending and rolling back — where
 * a reminder could go twice. Preferred deliberately: a duplicate reminder is
 * mildly annoying, a missing one costs somebody their session.
 */
async function sendDueReminders(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const dueBy = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3_600_000).toISOString();
  const createdBefore = new Date(now.getTime() - REMINDER_MIN_AGE_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, starts_at, client_email, client_name, client_timezone, price_centavos, meeting_url, intake_completed_at, ' +
        'facilitators(email, display_name, timezone), facilitator_services(title, intake_questions)',
    )
    .eq('status', 'confirmed')
    .is('reminder_sent_at', null)
    .gt('starts_at', now.toISOString())
    .lte('starts_at', dueBy)
    .lt('created_at', createdBefore)
    .limit(200);

  if (error) throw error;

  let sent = 0;
  for (const booking of (data ?? []) as unknown as ReminderRow[]) {
    const { data: claimed, error: claimError } = await supabase
      .from('bookings')
      .update({ reminder_sent_at: now.toISOString() })
      .eq('id', booking.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle<{ id: string }>();

    if (claimError) {
      console.error('[bookingSweep] could not claim reminder', { bookingId: booking.id, claimError });
      continue;
    }
    // Another invocation got there first and is sending it.
    if (!claimed) continue;

    const facilitator = booking.facilitators;
    const service = booking.facilitator_services;
    if (!facilitator || !service) {
      console.warn('[bookingSweep] skipping reminder, relations missing', { bookingId: booking.id });
      continue;
    }

    try {
      await sendBookingReminder({
        clientEmail: booking.client_email,
        clientName: booking.client_name,
        facilitatorEmail: facilitator.email,
        facilitatorName: facilitator.display_name,
        facilitatorTimezone: facilitator.timezone,
        clientTimezone: booking.client_timezone,
        // Only nudged when the service actually asks something — an empty
        // form must not produce a reminder pointing at nothing.
        intakePending:
          booking.intake_completed_at === null &&
          Array.isArray(service.intake_questions) &&
          service.intake_questions.length > 0,
        serviceTitle: service.title,
        startsAt: booking.starts_at,
        meetingUrl: booking.meeting_url,
        isFree: booking.price_centavos === 0,
      });
      sent += 1;
    } catch (err) {
      console.error('[bookingSweep] reminder send failed, releasing for retry', {
        bookingId: booking.id,
        err,
      });
      await supabase.from('bookings').update({ reminder_sent_at: null }).eq('id', booking.id);
    }
  }

  return sent;
}

export async function handler(): Promise<void> {
  const now = new Date();

  // Independent of each other, and one failing must not stop the other: a
  // stuck hold sweep should not also mean nobody gets paid this cycle.
  const [released, completed, reminded] = await Promise.all([
    releaseExpiredHolds(now).catch((err) => {
      console.error('[bookingSweep] releasing expired holds failed', err);
      return 0;
    }),
    completePastSessions(now).catch((err) => {
      console.error('[bookingSweep] completing past sessions failed', err);
      return 0;
    }),
    sendDueReminders(now).catch((err) => {
      console.error('[bookingSweep] sending reminders failed', err);
      return 0;
    }),
  ]);

  if (released > 0 || completed > 0 || reminded > 0) {
    console.log(
      `[bookingSweep] released ${released} hold(s), completed ${completed} session(s), ` +
        `reminded ${reminded} booking(s)`,
    );
  }
}

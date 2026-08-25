/**
 * EventBridge-scheduled housekeeping for event registrations (see
 * `RegistrationSweepRule` in the CDK stack — runs every 5 minutes, alongside
 * the booking sweep and the publish sweep).
 *
 * A separate Lambda from booking-sweep.ts rather than more jobs inside it:
 * different failure domain, different SES grant, and a stuck reminder loop
 * here must not also stop bookings being completed.
 *
 * Five jobs, all independent — one failing must not stop the others:
 *
 *  1. **Release lapsed holds.** `claim_event_seat` releases *this event's*
 *     lapsed holds inline on every new claim, which covers the common case
 *     immediately. This sweep is what handles an event nobody happens to be
 *     registering for right now, and it releases across every event in one
 *     pass. Unlike a booking's slot (freed by deletion), the row is *kept* as
 *     `expired` — they typed their dietary needs and an emergency contact in,
 *     and "they tried and the QR timed out" is a sales lead, not noise.
 *
 *  2. **Flag overdue charges — never cancel.** This is the product rule
 *     stated in code: a missed instalment gets a stamp and an admin email,
 *     and the seat stays held until a human decides otherwise. Whoever reads
 *     this six weeks from now and wonders why an unpaid registration is still
 *     `confirmed` — that is not a bug, that is the policy.
 *
 *  3. **Remind the registrant**, on four tiers per charge (due in 7 days, due
 *     today, 3 days overdue, 7 days overdue). QRPh is the only activated
 *     payment method, so nothing here can ever auto-charge anyone — every
 *     instalment is a payment the registrant chooses to make, which is why
 *     these reminders matter more than anywhere else in the product.
 *
 *  4. **Complete past events.** A day after an event ends, its confirmed
 *     registrations move to `completed` — the same distinction bookings draw
 *     between "on the calendar" and "delivered".
 *
 *  5. **Expire stale checkout sessions.** A non-deposit charge left
 *     `awaiting_payment` past its session's expiry reverts to `scheduled` so
 *     an abandoned "pay next instalment" click cannot permanently block the
 *     next attempt.
 *
 * Idempotent throughout. Reminders use claim-by-insert into
 * registration_charge_reminders (0017) — the unique index on (charge_id,
 * tier) makes the insert itself the claim, which is a stronger guarantee than
 * booking-sweep's claim-then-stamp: the loser of a race gets a plain 23505
 * rather than a filtered update that quietly matched nothing. On send
 * failure the claim row is deleted so the next sweep retries, the same
 * accepted narrow window as booking-sweep: a crash between send and rollback
 * can duplicate a reminder, which is preferred over losing one — a lost
 * reminder costs someone their seat.
 */
import { getSupabase } from '../lib/supabase.js';
import { sendChargeReminder, sendOverdueAdminAlert } from '../lib/registration-email.js';

async function releaseExpiredHolds(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('event_registrations')
    .update({ status: 'expired', error_detail: null })
    .eq('status', 'pending_payment')
    .lt('hold_expires_at', now.toISOString())
    .select('id');

  if (error) throw error;
  return (data ?? []).length;
}

interface FlagRow {
  id: string;
  registration_id: string;
  event_id: string;
  label: string;
  amount_centavos: number;
  currency: string;
  due_at: string;
}

const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;

/**
 * Stamps every unpaid charge past its due date, rolls the flag up to the
 * registration, and tells an admin once per charge.
 *
 * Never touches `status`. The seat stays confirmed and held — see the header
 * comment. A charge already flagged is excluded by the `is('flagged_at',
 * null)` filter, so re-running this costs nothing and sends nothing twice.
 */
async function flagOverdue(now: Date): Promise<number> {
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('registration_charges')
    .select('id, registration_id, event_id, label, amount_centavos, currency, due_at')
    .in('status', ['scheduled', 'awaiting_payment'])
    .is('flagged_at', null)
    .lt('due_at', now.toISOString())
    .limit(200)
    .returns<FlagRow[]>();
  if (error) throw error;

  let flagged = 0;
  for (const charge of data ?? []) {
    const { data: claimed, error: claimError } = await supabase
      .from('registration_charges')
      .update({ flagged_at: now.toISOString() })
      .eq('id', charge.id)
      .is('flagged_at', null)
      .select('id')
      .maybeSingle<{ id: string }>();
    if (claimError) {
      console.error('[registrationSweep] could not claim overdue flag', { chargeId: charge.id, claimError });
      continue;
    }
    if (!claimed) continue; // another invocation got there first

    await supabase
      .from('event_registrations')
      .update({ flagged_at: now.toISOString(), flag_reason: 'installment_overdue' })
      .eq('id', charge.registration_id)
      .is('flagged_at', null);

    flagged += 1;

    if (ADMIN_ALERT_EMAIL) {
      try {
        await sendOverdueAdminAlert({
          to: ADMIN_ALERT_EMAIL,
          registrationId: charge.registration_id,
          label: charge.label,
          amountCentavos: charge.amount_centavos,
          currency: charge.currency,
          dueAt: charge.due_at,
        });
      } catch (err) {
        // The flag itself already succeeded and will not be retried — this is
        // best-effort notification on top of a fact already recorded.
        console.error('[registrationSweep] overdue admin alert failed', { chargeId: charge.id, err });
      }
    }
  }
  return flagged;
}

type ReminderTier = 'due_in_7d' | 'due_today' | 'overdue_3d' | 'overdue_7d';

/** [daysFromDue at the window's near edge, days at its far edge). */
const TIER_WINDOWS: { tier: ReminderTier; fromDays: number; toDays: number }[] = [
  { tier: 'due_in_7d', fromDays: 6, toDays: 7 },
  { tier: 'due_today', fromDays: 0, toDays: 1 },
  { tier: 'overdue_3d', fromDays: -4, toDays: -3 },
  { tier: 'overdue_7d', fromDays: -8, toDays: -7 },
];

interface ReminderChargeRow {
  id: string;
  registration_id: string;
  label: string;
  amount_centavos: number;
  currency: string;
  due_at: string;
  event_registrations: {
    buyer_email: string;
    registrant_name: string;
    status: string;
    events: { title: string } | null;
  } | null;
}

/**
 * Sends the four-tier reminders.
 *
 * Windows are a day wide rather than a point in time, so a missed 5-minute
 * cycle never skips a tier — the next run still finds the charge inside its
 * window. Scoped to `confirmed` registrations only: a reminder about a hold
 * that never turned into a place would be confusing, and that case is what
 * `releaseExpiredHolds` handles instead.
 */
async function sendChargeReminders(now: Date): Promise<number> {
  const supabase = await getSupabase();
  let sent = 0;

  for (const { tier, fromDays, toDays } of TIER_WINDOWS) {
    const from = new Date(now.getTime() + fromDays * 86_400_000).toISOString();
    const to = new Date(now.getTime() + toDays * 86_400_000).toISOString();

    const { data, error } = await supabase
      .from('registration_charges')
      .select(
        'id, registration_id, label, amount_centavos, currency, due_at, ' +
          'event_registrations!inner(buyer_email, registrant_name, status, events(title))',
      )
      .in('status', ['scheduled', 'awaiting_payment'])
      .eq('event_registrations.status', 'confirmed')
      .gte('due_at', from)
      .lt('due_at', to)
      .limit(200)
      .returns<ReminderChargeRow[]>();
    if (error) {
      console.error('[registrationSweep] reminder query failed', { tier, error });
      continue;
    }

    for (const charge of data ?? []) {
      const registration = charge.event_registrations;
      if (!registration || !registration.events) {
        console.warn('[registrationSweep] skipping reminder, relations missing', { chargeId: charge.id });
        continue;
      }

      // The insert IS the claim: the unique index on (charge_id, tier) means a
      // concurrent sweep loses here with a plain 23505, never with a filtered
      // update that quietly matched nothing.
      const { error: claimError } = await supabase
        .from('registration_charge_reminders')
        .insert({ charge_id: charge.id, tier, sent_to: registration.buyer_email });
      if (claimError) {
        if (claimError.code !== '23505') {
          console.error('[registrationSweep] could not claim reminder', { chargeId: charge.id, tier, claimError });
        }
        continue;
      }

      try {
        await sendChargeReminder({
          tier,
          to: registration.buyer_email,
          registrantName: registration.registrant_name,
          eventTitle: registration.events.title,
          label: charge.label,
          amountCentavos: charge.amount_centavos,
          currency: charge.currency,
          dueAt: charge.due_at,
          registrationId: charge.registration_id,
        });
        sent += 1;
      } catch (err) {
        console.error('[registrationSweep] reminder send failed, releasing for retry', {
          chargeId: charge.id,
          tier,
          err,
        });
        await supabase
          .from('registration_charge_reminders')
          .delete()
          .eq('charge_id', charge.id)
          .eq('tier', tier);
      }
    }
  }

  return sent;
}

/** How long after an event ends before its registrations count as delivered. */
const COMPLETION_GRACE_HOURS = 24;

async function completePastEvents(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const cutoff = new Date(now.getTime() - COMPLETION_GRACE_HOURS * 3_600_000);

  // events.ends_at is nullable (a one-line listing has no meaningful end
  // time); coalesce to starts_at, same rule the public /events split uses.
  const { data: pastEvents, error: eventError } = await supabase
    .from('events')
    .select('id, starts_at, ends_at')
    .eq('ticketing_enabled', true)
    .returns<{ id: string; starts_at: string; ends_at: string | null }[]>();
  if (eventError) throw eventError;

  const eventIds = (pastEvents ?? [])
    .filter((e) => new Date(e.ends_at ?? e.starts_at) < cutoff)
    .map((e) => e.id);
  if (eventIds.length === 0) return 0;

  const { data, error } = await supabase
    .from('event_registrations')
    .update({ status: 'completed' })
    .eq('status', 'confirmed')
    .in('event_id', eventIds)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Reverts a non-deposit charge stuck `awaiting_payment` past its session's
 * expiry back to `scheduled`, clearing the dead checkout url.
 *
 * The deposit is deliberately excluded — an expired deposit session belongs to
 * a `pending_payment` registration, and `releaseExpiredHolds` is what handles
 * that one, by expiring the whole registration rather than reverting one
 * charge.
 */
async function expireStaleCheckouts(now: Date): Promise<number> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('registration_charges')
    .update({ status: 'scheduled', checkout_url: null, checkout_expires_at: null, paymongo_session_id: null })
    .eq('status', 'awaiting_payment')
    .eq('is_deposit', false)
    .lt('checkout_expires_at', now.toISOString())
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

export async function handler(): Promise<void> {
  const now = new Date();

  const [released, flagged, reminded, completed, expiredCheckouts] = await Promise.all([
    releaseExpiredHolds(now).catch((err) => {
      console.error('[registrationSweep] releasing expired holds failed', err);
      return 0;
    }),
    flagOverdue(now).catch((err) => {
      console.error('[registrationSweep] flagging overdue charges failed', err);
      return 0;
    }),
    sendChargeReminders(now).catch((err) => {
      console.error('[registrationSweep] sending reminders failed', err);
      return 0;
    }),
    completePastEvents(now).catch((err) => {
      console.error('[registrationSweep] completing past events failed', err);
      return 0;
    }),
    expireStaleCheckouts(now).catch((err) => {
      console.error('[registrationSweep] expiring stale checkouts failed', err);
      return 0;
    }),
  ]);

  if (released > 0 || flagged > 0 || reminded > 0 || completed > 0 || expiredCheckouts > 0) {
    console.log(
      `[registrationSweep] released ${released} hold(s), flagged ${flagged} overdue charge(s), ` +
        `sent ${reminded} reminder(s), completed ${completed} registration(s), ` +
        `expired ${expiredCheckouts} stale checkout(s)`,
    );
  }
}

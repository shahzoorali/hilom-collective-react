/**
 * EventBridge-scheduled housekeeping for bookings (see `BookingSweepRule` in
 * the CDK stack — runs every 5 minutes, alongside the publish sweep).
 *
 * Two jobs, both of which exist because the database cannot do them itself:
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
 * Idempotent by construction — both operations are keyed on conditions that
 * stop being true once applied, so running twice changes nothing the second
 * time.
 */
import { getSupabase } from '../lib/supabase.js';

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

export async function handler(): Promise<void> {
  const now = new Date();

  // Independent of each other, and one failing must not stop the other: a
  // stuck hold sweep should not also mean nobody gets paid this cycle.
  const [released, completed] = await Promise.all([
    releaseExpiredHolds(now).catch((err) => {
      console.error('[bookingSweep] releasing expired holds failed', err);
      return 0;
    }),
    completePastSessions(now).catch((err) => {
      console.error('[bookingSweep] completing past sessions failed', err);
      return 0;
    }),
  ]);

  if (released > 0 || completed > 0) {
    console.log(`[bookingSweep] released ${released} hold(s), completed ${completed} session(s)`);
  }
}

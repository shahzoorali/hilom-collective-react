/**
 * Multi-session packages (0035): buying a block of sessions, and spending the
 * credits one at a time.
 *
 * Shared between the purchase handler, the PayMongo webhook and the booking
 * path, for the reason every other module in this directory is shared: "how
 * many credits are left" is asked from three places, and three answers is a
 * client scheduling a seventh session on a six-session package.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  splitPackageSessions,
  packageCreditsRemaining,
  type BookingStatus,
  type PackageSessionShare,
} from './booking-domain.js';
import { sendPackagePurchased } from './booking-email.js';

export type PackageStatus = 'pending_payment' | 'active' | 'cancelled' | 'refunded';

export interface PackageRow {
  id: string;
  facilitator_id: string;
  service_id: string;
  client_email: string;
  client_name: string | null;
  client_timezone: string | null;
  sessions_total: number;
  price_centavos: number;
  platform_fee_centavos: number;
  facilitator_net_centavos: number;
  currency: string;
  status: PackageStatus;
  refund_full_hours: number | null;
  refund_half_hours: number | null;
  created_at: string;
}

export const PACKAGE_COLUMNS =
  'id, facilitator_id, service_id, client_email, client_name, client_timezone, sessions_total, ' +
  'price_centavos, platform_fee_centavos, facilitator_net_centavos, currency, status, ' +
  'refund_full_hours, refund_half_hours, created_at';

/**
 * How many sessions of this package are still schedulable, and which share the
 * next one carries.
 *
 * The share is looked up by *position*, not recomputed from what is left: the
 * shares differ by up to a centavo (see `splitPackageSessions`), so "the next
 * one" has to mean a specific entry in a fixed list, or two clients booking in
 * a different order would be charged differently for the same package.
 *
 * Position is the count of credits already spent, which makes the allocation a
 * pure function of the package and its live bookings — nothing to store, and
 * nothing that can drift if a session is cancelled and rebooked.
 */
export async function packageState(
  supabase: SupabaseClient,
  pkg: PackageRow,
): Promise<{ remaining: number; used: number; nextShare: PackageSessionShare | null }> {
  const { data, error } = await supabase
    .from('bookings')
    .select('status')
    .eq('package_id', pkg.id);
  if (error) throw error;

  const statuses = (data ?? []).map((row) => row.status as BookingStatus);
  const remaining = packageCreditsRemaining(pkg.sessions_total, statuses);
  const used = pkg.sessions_total - remaining;

  const shares = splitPackageSessions(
    pkg.price_centavos,
    // Reconstructed from the snapshot rather than read off the facilitator's
    // current rate: this package was sold at a rate that may since have been
    // renegotiated, and the shares must add back to what was actually charged.
    pkg.price_centavos > 0
      ? Math.round((pkg.platform_fee_centavos / pkg.price_centavos) * 10_000)
      : 0,
    pkg.sessions_total,
  );

  return { remaining, used, nextShare: shares[used] ?? null };
}

/**
 * Marks a package paid and tells the buyer.
 *
 * Idempotent, like `confirmBooking` and for the same reason: PayMongo delivers
 * at least once, and a single hosted-checkout payment fires two fulfillable
 * events. Re-activating an active package is a no-op that returns cleanly
 * rather than sending a second email.
 *
 * Unlike a booking, there is no slot to hold and no meeting to create — a
 * package is a right to schedule, not a session. That is what makes this the
 * simple half of the flow, and it is also why the purchase never races anyone:
 * two people buying the last of nothing is not a conflict.
 */
export async function confirmPackage(
  supabase: SupabaseClient,
  packageId: string,
  paymentId?: string,
): Promise<{ packageId: string; status: PackageStatus; alreadyActive: boolean }> {
  const { data: pkg, error } = await supabase
    .from('booking_packages')
    .select(`${PACKAGE_COLUMNS}, facilitators(email, display_name, timezone), facilitator_services(title)`)
    .eq('id', packageId)
    .maybeSingle<any>();

  if (error) throw error;
  if (!pkg) throw new Error(`Package ${packageId} not found`);

  if (pkg.status === 'active') {
    return { packageId, status: 'active', alreadyActive: true };
  }
  if (pkg.status !== 'pending_payment') {
    // Cancelled or refunded. A late payment against one is a support question,
    // not something to silently reactivate.
    throw new Error(`Package ${packageId} is ${pkg.status} and cannot be activated`);
  }

  const { data: activated, error: updateError } = await supabase
    .from('booking_packages')
    .update({ status: 'active', paymongo_payment_id: paymentId ?? null })
    .eq('id', packageId)
    // Read back, so a concurrent redelivery loses cleanly rather than both
    // sides believing they activated it and sending two emails.
    .eq('status', 'pending_payment')
    .select('id')
    .maybeSingle<{ id: string }>();

  if (updateError) throw updateError;
  if (!activated) return { packageId, status: 'active', alreadyActive: true };

  await sendPackagePurchased({
    clientEmail: pkg.client_email,
    clientName: pkg.client_name,
    clientTimezone: pkg.client_timezone,
    facilitatorEmail: pkg.facilitators?.email ?? '',
    facilitatorName: pkg.facilitators?.display_name ?? 'your facilitator',
    facilitatorTimezone: pkg.facilitators?.timezone ?? 'Asia/Manila',
    serviceTitle: pkg.facilitator_services?.title ?? 'Package',
    startsAt: new Date().toISOString(),
    isFree: pkg.price_centavos === 0,
  }, { sessionsTotal: pkg.sessions_total });

  return { packageId, status: 'active', alreadyActive: false };
}

/**
 * Package instalments (0077): the parts that touch the database.
 *
 * The rules live in package-installments.ts; this file reads sessions, writes
 * charge rows, opens checkouts and sends the emails.
 */
import { expireCheckoutSessions } from './paymongo-checkout.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHostedCheckout } from './paymongo-checkout.js';
import {
  chargeDueAt,
  chargeState,
  reminderTierFor,
  OUTSTANDING,
} from './package-installments.js';
import {
  sendPackageChargeReminder,
  sendPackageChargePaid,
  sendPackageChargeOverdue,
  type PackageChargeContext,
} from './package-email.js';

/** Sessions that hold a place on the calendar, and so count for due dates. */
const LIVE_SESSION = ['pending_payment', 'confirmed', 'completed', 'no_show'];

/** How long an opened "pay this instalment" checkout is reused before a fresh one. */
const CHECKOUT_REUSE_MS = 60 * 60_000;

export const PACKAGE_CHARGE_COLUMNS =
  'id, package_id, seq, label, amount_centavos, currency, due_session, status, platform_fee_centavos, ' +
  'facilitator_net_centavos, paid_at, paymongo_payment_id, paymongo_session_id, checkout_url, ' +
  'checkout_expires_at, flagged_overdue_at, created_at';

export interface PackageChargeRow {
  id: string;
  package_id: string;
  seq: number;
  label: string;
  amount_centavos: number;
  currency: string;
  due_session: number;
  status: string;
  platform_fee_centavos: number;
  facilitator_net_centavos: number;
  paid_at: string | null;
  paymongo_payment_id: string | null;
  paymongo_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  flagged_overdue_at: string | null;
  created_at: string;
}

export interface DecoratedCharge extends PackageChargeRow {
  due_at: string | null;
  state: ReturnType<typeof chargeState>;
}

/** Start times of a package's live sessions, earliest first. */
export async function packageSessionStarts(supabase: SupabaseClient, packageId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('starts_at')
    .eq('package_id', packageId)
    .in('status', LIVE_SESSION)
    .order('starts_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => r.starts_at as string);
}

/** A package's charges with their due date and paid/pending/overdue state. */
export async function packageChargesWithDue(
  supabase: SupabaseClient,
  packageId: string,
  now = new Date(),
): Promise<DecoratedCharge[]> {
  const [{ data, error }, starts] = await Promise.all([
    supabase.from('package_charges').select(PACKAGE_CHARGE_COLUMNS).eq('package_id', packageId).order('seq').returns<PackageChargeRow[]>(),
    packageSessionStarts(supabase, packageId),
  ]);
  if (error) throw error;
  return (data ?? []).map((c) => {
    const due = c.seq === 1 ? null : chargeDueAt(c.due_session, starts);
    return { ...c, due_at: due, state: chargeState(c.status, due, now) };
  });
}

interface PackageContextRow {
  id: string;
  client_email: string;
  client_name: string | null;
  client_timezone: string | null;
  status: string;
  facilitators: { email: string | null; display_name: string | null } | null;
  facilitator_services: { title: string | null } | null;
}

async function loadContext(supabase: SupabaseClient, packageId: string): Promise<PackageContextRow | null> {
  const { data, error } = await supabase
    .from('booking_packages')
    .select('id, client_email, client_name, client_timezone, status, facilitators(email, display_name), facilitator_services(title)')
    .eq('id', packageId)
    .maybeSingle<PackageContextRow>();
  if (error) throw error;
  return data;
}

function contextFor(pkg: PackageContextRow, c: PackageChargeRow): PackageChargeContext {
  return {
    clientEmail: pkg.client_email,
    clientName: pkg.client_name,
    clientTimezone: pkg.client_timezone,
    facilitatorEmail: pkg.facilitators?.email ?? '',
    facilitatorName: pkg.facilitators?.display_name ?? 'your facilitator',
    serviceTitle: pkg.facilitator_services?.title ?? 'Package',
    packageId: pkg.id,
    chargeId: c.id,
    label: c.label,
    amountCentavos: c.amount_centavos,
    currency: c.currency,
  };
}

/**
 * Records a payment against one charge, once. The conditional update is the
 * decision point: of two webhook deliveries for one payment, only one moves
 * the row and only that one sends the confirmations.
 *
 * `notify` is false for the first payment, which the package-purchased email
 * already covers.
 */
export async function applyPackageChargePayment(
  supabase: SupabaseClient,
  chargeId: string,
  paymentId: string | undefined,
  opts: { notify?: boolean } = {},
): Promise<{ status: 'paid' | 'already_paid' }> {
  const { data: won, error } = await supabase
    .from('package_charges')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      ...(paymentId ? { paymongo_payment_id: paymentId } : {}),
    })
    .eq('id', chargeId)
    .in('status', ['scheduled', 'awaiting_payment'])
    .select(PACKAGE_CHARGE_COLUMNS)
    .maybeSingle<PackageChargeRow>();
  if (error) throw error;
  if (!won) return { status: 'already_paid' };

  if (opts.notify !== false) {
    const pkg = await loadContext(supabase, won.package_id);
    if (pkg) {
      const { data: all } = await supabase
        .from('package_charges')
        .select('status, amount_centavos')
        .eq('package_id', won.package_id);
      const rows = all ?? [];
      const paidCount = rows.filter((r) => r.status === 'paid').length;
      const remaining = rows.filter((r) => OUTSTANDING.has(r.status as string)).reduce((s, r) => s + (r.amount_centavos as number), 0);
      await sendPackageChargePaid({ ...contextFor(pkg, won), paidCount, totalCount: rows.length, remainingCentavos: remaining });
    }
  }
  return { status: 'paid' };
}

/**
 * Opens (or reuses) a checkout for a client's next payment. Payments go in
 * order, so only the earliest outstanding charge can be paid.
 */
export async function openPackageChargeCheckout(
  supabase: SupabaseClient,
  packageId: string,
  chargeId: string,
  buyer: { email: string; name?: string | null },
): Promise<{ ok: true; checkoutUrl: string; amountCentavos: number; currency: string } | { ok: false; status: number; error: string }> {
  const pkg = await loadContext(supabase, packageId);
  if (!pkg || pkg.client_email.toLowerCase() !== buyer.email.toLowerCase()) {
    return { ok: false, status: 404, error: 'Package not found' };
  }
  if (pkg.status !== 'active') return { ok: false, status: 409, error: 'This package is not active.' };

  const charges = await packageChargesWithDue(supabase, packageId);
  const charge = charges.find((c) => c.id === chargeId);
  if (!charge) return { ok: false, status: 404, error: 'That payment is not part of this package.' };
  if (charge.status === 'paid') return { ok: false, status: 409, error: 'That payment has already been made.' };
  if (!OUTSTANDING.has(charge.status)) return { ok: false, status: 409, error: 'That payment is no longer due.' };
  const next = charges.find((c) => OUTSTANDING.has(c.status));
  if (next && next.id !== charge.id) {
    return { ok: false, status: 409, error: `Please pay "${next.label}" first; payments are made in order.` };
  }

  const now = Date.now();
  if (charge.checkout_url && charge.checkout_expires_at && Date.parse(charge.checkout_expires_at) > now) {
    return { ok: true, checkoutUrl: charge.checkout_url, amountCentavos: charge.amount_centavos, currency: charge.currency };
  }

  const origin = process.env.FRONTEND_URL ?? 'https://www.hilomcollective.com';
  const session = await createHostedCheckout({
    name: `${pkg.facilitator_services?.title ?? 'Package'} with ${pkg.facilitators?.display_name ?? 'your facilitator'}`,
    description: charge.label,
    amountCentavos: charge.amount_centavos,
    currency: charge.currency,
    billing: { email: pkg.client_email, name: buyer.name ?? pkg.client_name },
    metadata: { kind: 'package_charge', package_id: packageId, charge_id: charge.id, buyer_email: pkg.client_email },
    successUrl: `${origin}/account/bookings?package=${encodeURIComponent(packageId)}&paid=${encodeURIComponent(charge.id)}`,
    cancelUrl: `${origin}/account/bookings?package=${encodeURIComponent(packageId)}`,
  });

  const { error } = await supabase
    .from('package_charges')
    .update({
      status: 'awaiting_payment',
      paymongo_session_id: session.sessionId,
      checkout_url: session.checkoutUrl,
      checkout_expires_at: new Date(now + CHECKOUT_REUSE_MS).toISOString(),
    })
    .eq('id', charge.id)
    .in('status', ['scheduled', 'awaiting_payment']);
  if (error) throw error;

  return { ok: true, checkoutUrl: session.checkoutUrl, amountCentavos: charge.amount_centavos, currency: charge.currency };
}

/**
 * The scheduled job (runs from booking-sweep every 5 minutes):
 *  1. reminders 7 days, 3 days and on the day before the session a payment is
 *     tied to; one per tier per due date, claimed by insert, released on a
 *     failed send so the next run retries;
 *  2. an overdue alert to the facilitator and the team, once per charge, when
 *     that session starts with the payment still open (nothing is cancelled);
 *  3. an abandoned checkout reverts to `scheduled` so the next attempt starts
 *     clean.
 */
export async function sweepPackageCharges(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ reminded: number; flagged: number; reset: number }> {
  let reminded = 0;
  let flagged = 0;

  const { data: reset, error: resetError } = await supabase
    .from('package_charges')
    .update({ status: 'scheduled', checkout_url: null, checkout_expires_at: null })
    .eq('status', 'awaiting_payment')
    .gt('seq', 1)
    .lt('checkout_expires_at', now.toISOString())
    .select('id, paymongo_session_id');
  if (resetError) throw resetError;
  // Close the abandoned checkout too, so it cannot be paid alongside the next
  // one the client opens for the same instalment (0079).
  await expireCheckoutSessions((reset ?? []).map((r) => r.paymongo_session_id as string | null));

  const { data: open, error } = await supabase
    .from('package_charges')
    .select(`${PACKAGE_CHARGE_COLUMNS}, booking_packages!inner(status)`)
    .in('status', ['scheduled', 'awaiting_payment'])
    .gt('seq', 1)
    .eq('booking_packages.status', 'active')
    .limit(500)
    .returns<PackageChargeRow[]>();
  if (error) throw error;

  const byPackage = new Map<string, PackageChargeRow[]>();
  for (const c of open ?? []) byPackage.set(c.package_id, [...(byPackage.get(c.package_id) ?? []), c]);

  for (const [packageId, charges] of byPackage) {
    try {
      const [starts, pkg] = await Promise.all([packageSessionStarts(supabase, packageId), loadContext(supabase, packageId)]);
      if (!pkg) continue;
      for (const c of charges) {
        const dueIso = chargeDueAt(c.due_session, starts);
        if (!dueIso) continue; // that session is not scheduled yet
        const due = new Date(dueIso);

        if (due <= now) {
          if (!c.flagged_overdue_at) {
            const { data: claimed } = await supabase
              .from('package_charges')
              .update({ flagged_overdue_at: now.toISOString() })
              .eq('id', c.id)
              .is('flagged_overdue_at', null)
              .select('id')
              .maybeSingle();
            if (claimed) {
              await sendPackageChargeOverdue({ ...contextFor(pkg, c), dueAt: dueIso });
              flagged++;
            }
          }
          continue;
        }

        const tier = reminderTierFor(due, now);
        if (!tier) continue;
        const { data: claim, error: claimError } = await supabase
          .from('package_charge_reminders')
          .insert({ charge_id: c.id, tier, due_at: dueIso })
          .select('id')
          .maybeSingle<{ id: string }>();
        if (claimError) {
          if (claimError.code === '23505') continue; // already sent for this date
          throw claimError;
        }
        try {
          await sendPackageChargeReminder({ ...contextFor(pkg, c), tier, dueAt: dueIso, sessionNumber: c.due_session });
          reminded++;
        } catch (err) {
          await supabase.from('package_charge_reminders').delete().eq('id', claim!.id);
          console.error('[packageCharges] reminder send failed, will retry', { chargeId: c.id, err });
        }
      }
    } catch (err) {
      console.error('[packageCharges] package failed, continuing with the rest', { packageId, err });
    }
  }

  return { reminded, flagged, reset: (reset ?? []).length };
}

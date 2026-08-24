/**
 * Applying a cleared payment to a registration charge.
 *
 * The counterpart to booking-fulfillment.ts, and the **only** place a charge
 * becomes `paid`. The webhook calls it, the SQS retry consumer calls it, and
 * the admin's mark-paid-offline calls it — deliberately, so that a payment
 * taken by bank transfer produces the same seat confirmation, the same receipt
 * number and the same emails as one taken through PayMongo. Two paths to "this
 * is paid" would eventually disagree about one of those three.
 *
 * Idempotent throughout. PayMongo delivers at least once, and a single hosted
 * checkout fires both `payment.paid` and `checkout_session.payment.paid`, so
 * every state change here is a compare-and-set whose `.select()` decides
 * whether this delivery is the one that gets to send the email.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabase.js';
import { depositClearedLate, isOutstanding, type ChargeStatus } from './event-ticketing.js';
import {
  sendRegistrationConfirmed,
  sendPaymentReceipt,
  sendFullySettled,
} from './registration-email.js';

export interface ChargeResult {
  chargeId: string;
  status: ChargeStatus;
  /** True when another delivery (or an earlier one) already applied this. */
  alreadyPaid: boolean;
  registrationConfirmed: boolean;
}

interface ChargeRow {
  id: string;
  registration_id: string;
  event_id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  currency: string;
  due_at: string;
  status: ChargeStatus;
  paymongo_payment_id: string | null;
  receipt_no: string | null;
}

interface RegistrationRow {
  id: string;
  event_id: string;
  plan_id: string;
  buyer_email: string;
  registrant_name: string;
  registrant_email: string;
  status: string;
  seat_no: number;
  plan_name: string;
  plan_kind: 'full' | 'installment';
  total_centavos: number;
  currency: string;
  confirmed_at: string | null;
}

const CHARGE_COLUMNS =
  'id, registration_id, event_id, seq, label, is_deposit, amount_centavos, currency, due_at, status, ' +
  'paymongo_payment_id, receipt_no';

const REGISTRATION_COLUMNS =
  'id, event_id, plan_id, buyer_email, registrant_name, registrant_email, status, seat_no, ' +
  'plan_name, plan_kind, total_centavos, currency, confirmed_at';

export interface OfflinePayment {
  /** 'bank_transfer' | 'gcash_manual' | 'cash' — anything but 'paymongo'. */
  method: string;
  reference: string;
  paidAt?: string;
}

/**
 * Marks one charge paid, confirming the seat if it was the deposit.
 *
 * `paymentId` is absent for an offline payment and for a retry-queue
 * redelivery that has lost it, which is why it is stamped separately and
 * early rather than being part of the compare-and-set patch.
 */
export async function applyChargePayment(
  chargeId: string,
  paymentId?: string,
  offline?: OfflinePayment,
): Promise<ChargeResult> {
  const supabase = await getSupabase();

  const { data: charge, error } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    .eq('id', chargeId)
    .maybeSingle<ChargeRow>();

  if (error) throw error;
  if (!charge) throw new Error(`Registration charge ${chargeId} not found`);

  if (charge.status === 'paid') {
    return { chargeId, status: 'paid', alreadyPaid: true, registrationConfirmed: false };
  }

  // A charge voided or waived before the webhook landed must not be
  // resurrected by it. The payment id is still recorded so the money is
  // traceable to a row, and what to do about it becomes an admin decision with
  // the evidence attached rather than a silent loss.
  if (!isOutstanding(charge.status)) {
    console.warn('[registration-fulfillment] payment arrived for a charge that is no longer payable', {
      chargeId,
      status: charge.status,
    });
    if (paymentId) {
      await supabase.from('registration_charges').update({ paymongo_payment_id: paymentId }).eq('id', chargeId);
    }
    return { chargeId, status: charge.status, alreadyPaid: false, registrationConfirmed: false };
  }

  // Stamped before the compare-and-set, tolerating the unique violation that a
  // duplicate delivery raises. A retry arriving without a payment id can then
  // still find this row by id, and a genuine second payment for the same
  // charge collides here rather than silently overwriting the first one.
  if (paymentId) {
    const { error: stampError } = await supabase
      .from('registration_charges')
      .update({ paymongo_payment_id: paymentId })
      .eq('id', chargeId)
      .is('paymongo_payment_id', null);
    if (stampError && stampError.code !== '23505') throw stampError;
  }

  const receiptNo = charge.receipt_no ?? (await nextReceiptNo(supabase));

  const { data: claimed, error: updateError } = await supabase
    .from('registration_charges')
    .update({
      status: 'paid',
      paid_at: offline?.paidAt ?? new Date().toISOString(),
      paid_method: offline?.method ?? 'paymongo',
      paid_reference: offline?.reference ?? null,
      receipt_no: receiptNo,
      // Whatever it was flagged for, it is settled now.
      flagged_at: null,
      error_detail: null,
    })
    .eq('id', chargeId)
    // Only one delivery may match a still-payable row. The `.select()` is what
    // makes that guard real: without it a write matching *zero* rows is
    // indistinguishable from one that matched — neither raises an error — so
    // both deliveries would fall through and email a second receipt.
    .in('status', ['scheduled', 'awaiting_payment'])
    .select('id')
    .maybeSingle<{ id: string }>();

  if (updateError) {
    await supabase
      .from('registration_charges')
      .update({ error_detail: updateError.message })
      .eq('id', chargeId);
    throw updateError;
  }

  if (!claimed) {
    // Lost the race to a concurrent delivery, which has already sent the mail.
    return { chargeId, status: 'paid', alreadyPaid: true, registrationConfirmed: false };
  }

  const { data: registration, error: regError } = await supabase
    .from('event_registrations')
    .select(REGISTRATION_COLUMNS)
    .eq('id', charge.registration_id)
    .maybeSingle<RegistrationRow>();
  if (regError) throw regError;
  if (!registration) throw new Error(`Registration ${charge.registration_id} not found`);

  const confirmed = charge.is_deposit
    ? await confirmRegistration(supabase, registration, charge)
    : false;

  await notify(supabase, registration, charge, receiptNo, confirmed);

  return { chargeId, status: 'paid', alreadyPaid: false, registrationConfirmed: confirmed };
}

/** `HR-2026-000042`, from a sequence — see the note in migration 0016. */
async function nextReceiptNo(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc('next_receipt_no');
  if (error) throw error;
  return String(data);
}

/**
 * Turns a held seat into a confirmed one.
 *
 * Only the deposit does this, and only once. After it, nothing but an admin
 * decision takes the seat back — including a missed instalment, which is
 * flagged rather than swept. That is the product rule, and it is why the sweep
 * never touches `status`.
 */
async function confirmRegistration(
  supabase: SupabaseClient,
  registration: RegistrationRow,
  charge: ChargeRow,
): Promise<boolean> {
  if (registration.status !== 'pending_payment') return false;

  const now = new Date();

  const { data: claimed, error } = await supabase
    .from('event_registrations')
    .update({
      status: 'confirmed',
      hold_expires_at: null,
      confirmed_at: now.toISOString(),
      error_detail: null,
    })
    .eq('id', registration.id)
    .eq('status', 'pending_payment')
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) throw error;
  if (!claimed) return false;

  // The eligibility rule is that an instalment plan is available if the
  // *deposit clears* before the plan's cutoff — but a QRPh payment begun at
  // 23:52 on 30 September can clear at 00:03 on 1 October. Neither automatic
  // answer is acceptable: voiding a paid seat over a minute of clock is
  // indefensible, and silently honouring it grants a ₱5,000 discount nobody
  // approved. So the seat is confirmed either way and a human is told.
  const { data: plan } = await supabase
    .from('event_payment_plans')
    .select('available_until')
    .eq('id', registration.plan_id)
    .maybeSingle<{ available_until: string | null }>();

  if (
    depositClearedLate({
      planKind: registration.plan_kind,
      availableUntil: plan?.available_until ?? null,
      clearedAt: now,
    })
  ) {
    await supabase
      .from('event_registrations')
      .update({
        flagged_at: now.toISOString(),
        flag_reason: 'deposit_cleared_after_plan_cutoff',
      })
      .eq('id', registration.id);

    console.warn('[registration-fulfillment] deposit cleared after the plan cutoff — flagged for review', {
      registrationId: registration.id,
      chargeId: charge.id,
      availableUntil: plan?.available_until,
    });
  }

  return true;
}

/**
 * Sends whatever this payment earned.
 *
 * Only ever reached by the delivery that won the compare-and-set, so no email
 * here needs its own idempotency guard. Failures are swallowed inside the email
 * module: a receipt that did not send must not roll back a payment that did.
 */
async function notify(
  supabase: SupabaseClient,
  registration: RegistrationRow,
  charge: ChargeRow,
  receiptNo: string,
  confirmed: boolean,
): Promise<void> {
  const { data: event } = await supabase
    .from('events')
    .select('title, starts_at, ends_at, location, venue_details, format')
    .eq('id', registration.event_id)
    .maybeSingle<{
      title: string;
      starts_at: string;
      ends_at: string | null;
      location: string | null;
      venue_details: string | null;
      format: string | null;
    }>();

  const { data: charges } = await supabase
    .from('registration_charges')
    .select(CHARGE_COLUMNS)
    .eq('registration_id', registration.id)
    .order('seq', { ascending: true })
    .returns<ChargeRow[]>();

  const schedule = charges ?? [];
  const settled = schedule.length > 0 && schedule.every((c) => !isOutstanding(c.status));

  if (!event) {
    console.warn('[registration-fulfillment] event missing — skipping email', {
      registrationId: registration.id,
    });
    return;
  }

  const context = {
    registrationId: registration.id,
    buyerEmail: registration.buyer_email,
    registrantName: registration.registrant_name,
    event,
    registration,
    charges: schedule,
  };

  if (confirmed) {
    // One email, not two: the confirmation carries the receipt for the deposit
    // and the whole remaining schedule, because that is the message someone
    // keeps and refers back to.
    await sendRegistrationConfirmed({ ...context, charge, receiptNo });
  } else {
    await sendPaymentReceipt({ ...context, charge, receiptNo });
  }

  if (settled && registration.plan_kind === 'installment') {
    await sendFullySettled(context);
  }
}

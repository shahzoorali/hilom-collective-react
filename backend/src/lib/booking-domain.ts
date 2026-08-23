/**
 * Booking money and policy rules.
 *
 * Split out from the handlers because these are the decisions that have to be
 * identical everywhere they are made: the fee a facilitator sees quoted on
 * their earnings screen must be the fee actually written to the booking row,
 * and the refund the cancellation dialog promises must be the refund recorded.
 * Two copies of this arithmetic would eventually disagree, and the disagreement
 * would be about somebody's money.
 */

/** Kept in step with `public.booking_status` in 0012_bookings.sql. */
export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled_by_client'
  | 'cancelled_by_facilitator'
  | 'completed'
  | 'no_show'
  | 'refunded';

export type ServiceKind = 'exploratory' | 'standard' | 'package';

/** How long a `pending_payment` row holds a slot before the sweep reclaims it. */
export const HOLD_MINUTES = 20;

export interface FeeSplit {
  priceCentavos: number;
  platformFeeCentavos: number;
  facilitatorNetCentavos: number;
}

/**
 * Splits a price into Hilom's fee and the facilitator's share.
 *
 * All integer centavos. The rate is basis points rather than a percentage float
 * because 15% of ₱1,500 must be exactly ₱225 every time — floating point would
 * make the last centavo depend on the order of operations, and a one-centavo
 * drift repeated across a payout batch is the kind of thing that costs an
 * afternoon to reconcile.
 *
 * Rounding goes to the facilitator: the fee is rounded *down*, so a half-centavo
 * lands on their side of the split rather than Hilom's. The amounts are defined
 * as a pair so they always sum back to the price exactly.
 */
export function splitFee(priceCentavos: number, platformFeeBps: number): FeeSplit {
  const price = Math.max(0, Math.round(priceCentavos));
  const bps = Math.min(10_000, Math.max(0, Math.round(platformFeeBps)));
  const platformFeeCentavos = Math.floor((price * bps) / 10_000);
  return {
    priceCentavos: price,
    platformFeeCentavos,
    facilitatorNetCentavos: price - platformFeeCentavos,
  };
}

export interface RefundDecision {
  refundCentavos: number;
  /** Shown to the client in the cancellation confirmation. */
  reason: string;
}

/**
 * The cancellation policy, in one place.
 *
 *   24h or more before the session : full refund
 *   12 to 24h before               : half
 *   under 12h                      : none
 *   facilitator or admin cancels   : full, regardless of when
 *
 * The last rule is not a courtesy — a client who loses their slot through no
 * fault of their own and is also out of pocket does not come back.
 *
 * This *computes and records* an amount; it does not move money. Refunds are
 * executed by hand, consistent with the existing "manual revoke, no automation"
 * rule for course refunds. The row is the instruction to a human, and the
 * reason string is what both sides see.
 */
export function refundForCancellation(input: {
  priceCentavos: number;
  startsAt: Date;
  now: Date;
  cancelledBy: 'client' | 'facilitator' | 'admin';
}): RefundDecision {
  const { priceCentavos, startsAt, now, cancelledBy } = input;

  if (priceCentavos === 0) {
    return { refundCentavos: 0, reason: 'No payment was taken for this session.' };
  }

  if (cancelledBy !== 'client') {
    return {
      refundCentavos: priceCentavos,
      reason: 'The facilitator cancelled, so the session is refunded in full.',
    };
  }

  const hoursBefore = (startsAt.getTime() - now.getTime()) / 3_600_000;

  if (hoursBefore >= 24) {
    return { refundCentavos: priceCentavos, reason: 'Cancelled 24 hours or more in advance — refunded in full.' };
  }
  if (hoursBefore >= 12) {
    return {
      refundCentavos: Math.floor(priceCentavos / 2),
      reason: 'Cancelled between 12 and 24 hours in advance — half refunded.',
    };
  }
  return {
    refundCentavos: 0,
    reason: 'Cancelled less than 12 hours in advance — not refundable.',
  };
}

/**
 * How much notice a client must give to *move* a session rather than cancel it.
 *
 * Deliberately the same 24 hours that makes a cancellation free, and that
 * symmetry is the entire point. Below this line cancelling costs the client
 * money — half the price, then all of it — so a reschedule that stayed free
 * would be strictly the better move at every point: the slot is released just
 * the same, and nothing is paid for it. The facilitator loses a committed hour
 * with no compensation, which is the cancellation policy defeated by another
 * name rather than a separate feature.
 *
 * Above the line the two are already equivalent — the client could cancel for
 * a full refund and rebook — so allowing a direct move there is convenience,
 * not a loophole.
 */
export const RESCHEDULE_MIN_NOTICE_HOURS = 24;

export interface RescheduleDecision {
  allowed: boolean;
  /** Shown to the client when it isn't. Empty when it is. */
  reason: string;
}

/**
 * Whether a confirmed booking may still be moved.
 *
 * Judged on the booking's *current* start time, not the proposed new one —
 * the new time is checked separately by the slot engine, which enforces the
 * service's own notice period and advance window. What this guards is the hour
 * the facilitator has already set aside.
 *
 * Applies to free sessions too. There is no refund to protect there, but the
 * held hour is just as real, and one rule is easier to state than two.
 */
export function canReschedule(input: { startsAt: Date; now: Date }): RescheduleDecision {
  const hoursBefore = (input.startsAt.getTime() - input.now.getTime()) / 3_600_000;

  if (hoursBefore >= RESCHEDULE_MIN_NOTICE_HOURS) {
    return { allowed: true, reason: '' };
  }
  return {
    allowed: false,
    reason:
      `Sessions can be moved up to ${RESCHEDULE_MIN_NOTICE_HOURS} hours before they start. ` +
      'Closer than that, you can only cancel — and the refund depends on how much notice you give.',
  };
}

/**
 * Whether a booking still occupies its slot.
 *
 * Mirrors the predicate on the `bookings_no_overlap` exclusion constraint. It
 * exists so the slot engine's idea of "busy" cannot drift from the database's:
 * if these two ever disagree, the picker offers times that then fail to insert.
 */
export function isLiveBooking(status: BookingStatus): boolean {
  return status === 'pending_payment' || status === 'confirmed';
}

/**
 * Postgres error codes the booking insert is expected to hit under normal
 * concurrent use — not bugs, and not 500s.
 *
 *   23P01 exclusion_violation — someone took the slot microseconds earlier
 *   23505 unique_violation    — a second free exploratory call, or a redelivered
 *                               webhook re-inserting the same payment id
 */
export const EXCLUSION_VIOLATION = '23P01';
export const UNIQUE_VIOLATION = '23505';

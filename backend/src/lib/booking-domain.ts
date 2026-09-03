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
 * How much notice a client must give for a full, then a half, refund.
 *
 * Set per service (`facilitator_services.refund_full_hours` /
 * `refund_half_hours`, added in 0027) and snapshotted onto each booking, so a
 * facilitator tightening their policy cannot change what an already-booked
 * client is owed.
 */
export interface RefundPolicy {
  /** At or above this many hours' notice: full refund. */
  fullHours: number;
  /** At or above this many hours' notice: half. Below it: nothing. */
  halfHours: number;
}

/**
 * The ladder every service had hardcoded before 0027, and still the default
 * for a service that has never touched the setting.
 *
 * Also what a booking taken *before* 0027 is judged by: those rows have no
 * snapshot, and null there means "the policy of the day", not "no policy".
 */
export const DEFAULT_REFUND_POLICY: RefundPolicy = { fullHours: 24, halfHours: 12 };

/**
 * Coerces a stored pair — either of which may be null on a pre-0027 row — into
 * a usable policy.
 *
 * Clamps rather than rejects, and re-orders a half above a full instead of
 * throwing. This runs on the cancellation path, where the alternative to a
 * sane fallback is a client unable to cancel at all because of a bad number in
 * a column the database already constrains.
 */
export function resolveRefundPolicy(input: {
  fullHours?: number | null;
  halfHours?: number | null;
}): RefundPolicy {
  const clamp = (value: number | null | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(720, Math.max(0, Math.round(value)))
      : fallback;

  const fullHours = clamp(input.fullHours, DEFAULT_REFUND_POLICY.fullHours);
  const halfHours = Math.min(fullHours, clamp(input.halfHours, DEFAULT_REFUND_POLICY.halfHours));
  return { fullHours, halfHours };
}

/** "24 hours" / "1 hour" / "48 hours", for the sentences below. */
function hoursPhrase(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The policy as a sentence, generated from the numbers that will actually be
 * applied.
 *
 * This is the half of the fix that matters to the client: what they are shown
 * before booking and before cancelling is now derived from the same two
 * integers the refund is computed from, so the promise and the payout cannot
 * drift. The facilitator's free-text `cancellation_policy` is rendered
 * *beside* this as their own notes, never instead of it.
 */
export function describeRefundPolicy(policy: RefundPolicy): string {
  const { fullHours, halfHours } = policy;

  if (fullHours === 0) {
    return 'Cancel at any time before the session for a full refund.';
  }
  if (halfHours === fullHours) {
    return (
      `Cancel at least ${hoursPhrase(fullHours)} before the session for a full refund. ` +
      'Closer than that, the session is not refundable.'
    );
  }
  if (halfHours === 0) {
    return (
      `Cancel at least ${hoursPhrase(fullHours)} before the session for a full refund, ` +
      'or later for a half refund.'
    );
  }
  return (
    `Cancel at least ${hoursPhrase(fullHours)} before the session for a full refund, ` +
    `or at least ${hoursPhrase(halfHours)} before for a half refund. ` +
    `Under ${hoursPhrase(halfHours)}, the session is not refundable.`
  );
}

/**
 * The cancellation policy, in one place.
 *
 *   `fullHours` or more before the session : full refund
 *   `halfHours` to `fullHours` before      : half
 *   under `halfHours`                      : none
 *   facilitator or admin cancels           : full, regardless of when
 *
 * The last rule is not a courtesy — a client who loses their slot through no
 * fault of their own and is also out of pocket does not come back. It is also
 * deliberately *not* configurable per service: the thresholds a facilitator
 * sets govern what a client owes for changing their mind, not what the
 * facilitator may keep after changing theirs.
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
  /** Omitted for a pre-0027 booking, which is judged by the old fixed ladder. */
  policy?: RefundPolicy;
  /**
   * True when this session was scheduled against a package (0035). The money
   * was collected for the block, not for this hour, so cancelling returns the
   * credit rather than any of it.
   */
  fromPackage?: boolean;
}): RefundDecision {
  const { priceCentavos, startsAt, now, cancelledBy } = input;
  const policy = input.policy ?? DEFAULT_REFUND_POLICY;

  // Checked before everything else, including the free case, because it is a
  // different *kind* of answer: nothing is owed and nothing is lost. Someone
  // who bought six sessions and cancelled one still has six to use, and paying
  // out a per-session share here would refund money against a package that has
  // not been given up.
  if (input.fromPackage) {
    return {
      refundCentavos: 0,
      reason: 'This session has been returned to your package — book it again whenever you like.',
    };
  }

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

  if (hoursBefore >= policy.fullHours) {
    return {
      refundCentavos: priceCentavos,
      reason:
        policy.fullHours === 0
          ? 'Cancelled before the session — refunded in full.'
          : `Cancelled ${hoursPhrase(policy.fullHours)} or more in advance — refunded in full.`,
    };
  }
  if (hoursBefore >= policy.halfHours) {
    return {
      refundCentavos: Math.floor(priceCentavos / 2),
      reason:
        policy.halfHours === 0
          ? `Cancelled less than ${hoursPhrase(policy.fullHours)} in advance — half refunded.`
          : `Cancelled between ${hoursPhrase(policy.halfHours)} and ${hoursPhrase(policy.fullHours)} in advance — half refunded.`,
    };
  }
  return {
    refundCentavos: 0,
    reason: `Cancelled less than ${hoursPhrase(policy.halfHours)} in advance — not refundable.`,
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
 *
 * Since 0027 the line is wherever the service's own full-refund threshold sits
 * rather than a fixed 24 hours, because the argument above is about the
 * threshold, not about the number: a facilitator who requires 48 hours' notice
 * for a free cancellation would otherwise find every client at 47 hours simply
 * moving the session instead. This constant remains the default for a service
 * that has not set one.
 */
export const RESCHEDULE_MIN_NOTICE_HOURS = DEFAULT_REFUND_POLICY.fullHours;

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
export function canReschedule(input: {
  startsAt: Date;
  now: Date;
  /** Defaults to the 24h ladder, for a pre-0027 booking. */
  policy?: RefundPolicy;
}): RescheduleDecision {
  const minNoticeHours = (input.policy ?? DEFAULT_REFUND_POLICY).fullHours;
  const hoursBefore = (input.startsAt.getTime() - input.now.getTime()) / 3_600_000;

  if (hoursBefore >= minNoticeHours) {
    return { allowed: true, reason: '' };
  }
  return {
    allowed: false,
    reason:
      `Sessions can be moved up to ${hoursPhrase(minNoticeHours)} before they start. ` +
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

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/** One session's share of a package: what it is worth, and to whom. */
export interface PackageSessionShare extends FeeSplit {
  /** 0-based position in the package. Only meaningful next to `sessionsTotal`. */
  index: number;
}

/**
 * Splits a package price across its sessions.
 *
 * The invariant this exists to guarantee, and the only one that matters: the
 * shares sum back to the package totals *exactly* — every centavo of price,
 * every centavo of fee, every centavo of the facilitator's net. Payouts are
 * "sum the delivered bookings" (see 0035), so a rounding drift here is not a
 * cosmetic discrepancy; it is a facilitator being paid a different amount than
 * the client was charged, discovered at reconciliation.
 *
 * Computed by running total rather than by dividing and patching the remainder
 * onto the last session. `floor(total * (i+1) / n) - floor(total * i / n)`
 * telescopes: the shares up to any point sum to `floor(total * k / n)`, so the
 * full set sums to `total` by construction, for every total and every n, with
 * no special case to get wrong. Divide-and-patch gets the same answer but only
 * because of a correction step, and the correction is where the bug lives — it
 * has to be applied to the price, the fee *and* the net, consistently, or the
 * three stop agreeing with each other.
 *
 * A consequence worth stating: shares can differ by one centavo. ₱1,000 over 3
 * sessions is 33334/33333/33333, not three equal parts, because three equal
 * parts of ₱1,000 do not exist. The facilitator is quoted the package total;
 * the per-session figure is an internal allocation.
 *
 * The fee is split *once*, on the package as a whole, and then allocated —
 * rather than charged per session — so that the total fee is exactly the rate
 * on the price the client actually paid, rather than the sum of N independent
 * roundings.
 */
export function splitPackageSessions(
  priceCentavos: number,
  platformFeeBps: number,
  sessionsTotal: number,
): PackageSessionShare[] {
  const sessions = Math.max(1, Math.floor(sessionsTotal));
  const total = splitFee(priceCentavos, platformFeeBps);

  const allocate = (amount: number, index: number) =>
    Math.floor((amount * (index + 1)) / sessions) - Math.floor((amount * index) / sessions);

  return Array.from({ length: sessions }, (_, index) => {
    const price = allocate(total.priceCentavos, index);
    const fee = allocate(total.platformFeeCentavos, index);
    return {
      index,
      priceCentavos: price,
      platformFeeCentavos: fee,
      // Derived rather than allocated separately, so a session's own three
      // numbers always agree even though each is a share of a different total.
      // Allocating the net independently would let price − fee ≠ net on an
      // individual row while the columns still summed correctly overall, which
      // is the worse kind of wrong: invisible in aggregate, obvious on a
      // receipt.
      facilitatorNetCentavos: price - fee,
    };
  });
}

/**
 * How many sessions of a package are still schedulable.
 *
 * A cancelled session returns its credit — the client paid for six sessions and
 * cancelling one is not a way to be owed five. Which is also why this counts
 * *live and delivered* bookings rather than all of them: `pending_payment` has
 * no meaning inside a package (nothing is being paid for), and cancelled rows
 * hand the credit back.
 */
export function packageCreditsRemaining(
  sessionsTotal: number,
  bookingStatuses: BookingStatus[],
): number {
  const spent = bookingStatuses.filter(
    (status) => status === 'confirmed' || status === 'completed' || status === 'no_show',
  ).length;
  return Math.max(0, sessionsTotal - spent);
}

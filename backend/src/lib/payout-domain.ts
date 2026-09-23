/**
 * The arithmetic behind a payout batch (0013, extended for classes by 0051).
 *
 * Extracted from `admin-facilitators.ts` because it is the part that decides
 * how much money a person is sent, and it was the one piece of this system
 * with no test behind it. The handler keeps the database work — reading the
 * unpaid rows, inserting the batch, stamping the claims — and everything that
 * is a decision about numbers lives here, where it can be run against the
 * cases that actually matter.
 *
 * ## The failure this exists to prevent
 *
 * A payout batch is built in two steps that cannot be one transaction through
 * PostgREST:
 *
 *   1. read every unpaid, delivered row in the period, and total it
 *   2. stamp those rows with the new batch's id
 *
 * Between those, another admin can build an overlapping batch and take some of
 * the same rows. Step 2 guards against *claiming* them twice by re-asserting
 * `payout_id is null` — but the totals came from step 1, so without a second
 * reconciliation the batch still pays for work it did not win, and the other
 * batch pays for it as well. Same session, paid twice, to a facilitator who
 * has no way of knowing.
 *
 * `reconcileClaim` is that reconciliation, and the tests beside it are the
 * only thing standing between a race and a real overpayment.
 */

/**
 * One piece of payable work, from either source.
 *
 * Bookings and class registrations carry identical money columns by design
 * (0051), which is what lets one function total both instead of two that have
 * to be kept in step.
 */
export interface PayableRow {
  id: string;
  price_centavos: number;
  platform_fee_centavos: number;
  facilitator_net_centavos: number;
  currency?: string | null;
}

export interface PayableTotals {
  /** What clients paid, before Hilom's cut. */
  gross: number;
  /** Hilom's cut. */
  fees: number;
  /** What the facilitator is owed, before payment-processing costs. */
  net: number;
  /** How many pieces of work this covers. */
  count: number;
}

/**
 * Totals a set of payable rows.
 *
 * Every field is read through `Number(x ?? 0)` rather than trusted: these rows
 * come back from PostgREST, where a numeric column can arrive as a string, and
 * a silent `'800' + '800' === '800800'` in a payout would be discovered by the
 * facilitator, not by us.
 */
export function sumPayable(rows: readonly PayableRow[]): PayableTotals {
  return rows.reduce<PayableTotals>(
    (acc, row) => ({
      gross: acc.gross + Number(row.price_centavos ?? 0),
      fees: acc.fees + Number(row.platform_fee_centavos ?? 0),
      net: acc.net + Number(row.facilitator_net_centavos ?? 0),
      count: acc.count + 1,
    }),
    { gross: 0, fees: 0, net: 0, count: 0 },
  );
}

export type PayoutReconciliation =
  | {
      /** Every row this batch read was still unpaid when it stamped them. */
      outcome: 'exact';
      totals: PayableTotals;
      netAfterProcessing: number;
    }
  | {
      /** A concurrent batch took some. The totals below are what this batch won. */
      outcome: 'partial';
      totals: PayableTotals;
      netAfterProcessing: number;
      lost: number;
    }
  | {
      /** A concurrent batch took all of them. Nothing to pay; void the batch. */
      outcome: 'empty';
    };

/**
 * Decides what a batch actually owes, given what it read and what it won.
 *
 * `claimed` must be the rows read back *from the stamping update*, not the
 * rows from the initial read. Passing the initial read here would make this
 * function a no-op and restore the double-payment it exists to prevent.
 *
 * The processing fee is subtracted from net rather than from gross: it is a
 * cost of sending the money, not a share of the sale, and Hilom's platform fee
 * has already been taken out. It is allowed to push net negative — a tiny
 * batch can genuinely cost more to send than it contains — because silently
 * clamping to zero would hide that from the person deciding whether to send
 * it.
 */
export function reconcileClaim(input: {
  expected: readonly PayableRow[];
  claimed: readonly PayableRow[];
  processingFeeCentavos: number;
}): PayoutReconciliation {
  const { expected, claimed, processingFeeCentavos } = input;

  if (claimed.length === 0) return { outcome: 'empty' };

  const totals = sumPayable(claimed);
  const netAfterProcessing = totals.net - processingFeeCentavos;

  if (claimed.length === expected.length) {
    return { outcome: 'exact', totals, netAfterProcessing };
  }

  return {
    outcome: 'partial',
    totals,
    netAfterProcessing,
    lost: expected.length - claimed.length,
  };
}

/**
 * The currency for a batch drawn from both sources.
 *
 * Bookings first only because that is the larger set in practice; either may
 * be empty. Falls back to PHP, which is the column default everywhere and the
 * only currency the platform has ever charged in — a batch is never built from
 * nothing, so this fallback is for the type system rather than for a real case.
 */
export function payoutCurrency(...sources: readonly (readonly PayableRow[])[]): string {
  for (const rows of sources) {
    for (const row of rows) {
      if (row.currency) return row.currency;
    }
  }
  return 'PHP';
}

// ---------------------------------------------------------------------------
// Voiding a batch
// ---------------------------------------------------------------------------

/**
 * Every table whose rows `buildPayout` stamps with a `payout_id`.
 *
 * Voiding a batch must release *all* of them, or the rows left behind keep
 * pointing at a void batch, fail every later `payout_id is null` claim, and
 * that work is never paid. This list is the one place that says what "all" is:
 * 0051 added `class_registrations` as a second source and the void path went
 * on releasing only `bookings` — class earnings in a voided batch were
 * silently unpayable. A third source added to `buildPayout` goes here too.
 */
export const PAYOUT_CLAIM_TABLES = ['bookings', 'class_registrations', 'registration_charges'] as const;

/**
 * What each claim table calls the amount the client paid.
 *
 * Bookings and class seats both say `price_centavos`; an event charge says
 * `amount_centavos`, because a charge is one instalment of a price rather than
 * the price itself (0016). Reads alias it back to `price_centavos` so that one
 * `PayableRow` shape — and therefore one `sumPayable` — covers all three.
 */
export const PAYOUT_PRICE_COLUMN: Record<(typeof PAYOUT_CLAIM_TABLES)[number], string> = {
  bookings: 'price_centavos',
  class_registrations: 'price_centavos',
  registration_charges: 'amount_centavos',
};

/**
 * The column every claim table also uses to record a clawback (0059) — one
 * name because it means the same thing on all three: the batch that took
 * this row's net back out of a facilitator's hands after a refund arrived
 * once `payout_id` had already paid for it. Voiding a batch releases both
 * columns for the same reason it releases `payout_id`.
 */
export const PAYOUT_CLAWBACK_COLUMN = 'clawed_back_payout_id';

/**
 * Totals what a set of clawback rows takes back.
 *
 * Reuses `PayableRow` — a clawback row is read with the same columns a
 * payable one is, just filtered to work that was paid out and has since been
 * refunded — so this is `sumPayable(rows).net`, named for what the number
 * means at the call site: money leaving the facilitator's net, not entering
 * it.
 */
export function sumClawback(rows: readonly PayableRow[]): number {
  return sumPayable(rows).net;
}

export type VoidDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether a batch in `currentStatus` may be voided.
 *
 * `paid` is refused. The money has left, and releasing that work back into the
 * unpaid pool would put it in the next batch: the same sessions, paid twice.
 * The admin screen already hides Void on a paid batch; this makes the API say
 * the same rather than trust the button.
 *
 * `void` is allowed. Re-voiding does nothing to the batch and re-runs the
 * release, so it is the recovery path for a void that failed half-way, and
 * the handler releases rows *before* it marks the batch void for the same
 * reason (see updatePayout).
 */
export function canVoidPayout(currentStatus: string): VoidDecision {
  if (currentStatus === 'paid') {
    return {
      ok: false,
      reason:
        'A paid payout cannot be voided — the money has already been sent, and voiding would ' +
        'release its sessions to be paid again in the next batch.',
    };
  }
  return { ok: true };
}

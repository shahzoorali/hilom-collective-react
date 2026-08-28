/**
 * Ticketed-event money and schedule rules.
 *
 * Split out from the handlers for the same reason booking-domain.ts is: these
 * are the decisions that have to be identical everywhere they are made. The
 * schedule quoted on the registration page must be the schedule written to the
 * charge ledger, which must be the schedule the confirmation email prints and
 * the one the reminder job chases. Four copies of this arithmetic would
 * eventually disagree, and the disagreement would be about somebody's money.
 *
 * Everything here is pure — no Supabase, no PayMongo, no clock of its own.
 * `now` is always a parameter, which is what makes the September-cutoff rules
 * testable without waiting for September.
 */

/** Kept in step with `public.registration_status` in 0016_event_ticketing.sql. */
export type RegistrationStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'expired'
  | 'cancelled'
  | 'completed';

/** Kept in step with `public.charge_status` in 0016_event_ticketing.sql. */
export type ChargeStatus =
  | 'scheduled'
  | 'awaiting_payment'
  | 'paid'
  | 'waived'
  | 'void'
  | 'refunded';

/** Kept in step with `public.payment_plan_kind`. */
export type PaymentPlanKind = 'full' | 'installment';

/** Kept in step with `public.event_format`. */
export type EventFormat = 'residential' | 'virtual' | 'day';

/**
 * The Philippines has never observed daylight saving and has been a single
 * UTC+8 zone since 1978, so the offset can be a constant rather than an Intl
 * round-trip. If that ever changes this is the one line to revisit — which is
 * precisely why every Manila conversion in the codebase goes through the two
 * functions below and none do it inline.
 */
const MANILA_OFFSET = '+08:00';

export class TicketingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketingValidationError';
  }
}

/**
 * The instant a Manila calendar date ends.
 *
 * "Due 31 October" means what a registrant in Lipa thinks it means: they have
 * until the end of that day, local time. Storing 2026-10-31T00:00:00Z would
 * make a payment at eight in the evening Manila time already late, and storing
 * the browser's midnight would make the due date depend on where the admin was
 * sitting when they typed it.
 *
 * Takes a plain `YYYY-MM-DD`, returns an ISO instant.
 */
export function endOfDayManila(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new TicketingValidationError(`Expected a YYYY-MM-DD date, got "${dateStr}"`);
  }
  const instant = new Date(`${dateStr}T23:59:59${MANILA_OFFSET}`);
  if (Number.isNaN(instant.getTime())) {
    throw new TicketingValidationError(`"${dateStr}" is not a real date`);
  }
  return instant.toISOString();
}

/**
 * The instant a Manila calendar date begins.
 *
 * The counterpart to endOfDayManila, used for the opening edge of an
 * availability window: a plan "available from 1 October" starts at Manila
 * midnight, not at whatever midnight the admin's browser was in.
 */
export function startOfDayManila(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new TicketingValidationError(`Expected a YYYY-MM-DD date, got "${dateStr}"`);
  }
  const instant = new Date(`${dateStr}T00:00:00${MANILA_OFFSET}`);
  if (Number.isNaN(instant.getTime())) {
    throw new TicketingValidationError(`"${dateStr}" is not a real date`);
  }
  return instant.toISOString();
}

/** The Manila calendar date an instant falls on, as `YYYY-MM-DD`. */
export function manilaDate(at: Date): string {
  // Shift into Manila's offset, then read the UTC parts — the shifted date's
  // UTC fields are Manila's local fields by construction.
  const shifted = new Date(at.getTime() + 8 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Splits a total into `n` whole-centavo parts that sum back to it exactly.
 *
 * The remainder lands on the *last* part, so a customer never pays the rounding
 * early. ₱25,000 over three instalments is 8,333.33 / 8,333.33 / 8,333.34 —
 * not 8,333.35 three times, which is what a calculator and a human produce and
 * which overcharges by five centavos.
 */
export function splitEvenly(totalCentavos: number, parts: number): number[] {
  if (!Number.isInteger(totalCentavos) || totalCentavos < 0) {
    throw new TicketingValidationError('A total must be a whole number of centavos');
  }
  if (!Number.isInteger(parts) || parts < 1) {
    throw new TicketingValidationError('A schedule needs at least one part');
  }
  const base = Math.floor(totalCentavos / parts);
  const out = new Array(parts).fill(base) as number[];
  out[parts - 1] = totalCentavos - base * (parts - 1);
  return out;
}

export interface PaymentPlan {
  id: string;
  name: string;
  kind: PaymentPlanKind;
  total_centavos: number;
  currency: string;
  available_from: string | null;
  available_until: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface PlanInstallment {
  seq: number;
  label: string;
  amount_centavos: number;
  due_at: string | null;
  due_offset_days: number | null;
  is_deposit: boolean;
}

/**
 * The plans on offer at a given moment.
 *
 * This is what makes "₱30,000 with instalments until 30 September, ₱35,000 in
 * full after" a data configuration rather than a branch in the handler: both
 * early-bird plans carry `available_until`, the regular plan carries
 * `available_from`, and the cutoff enforces itself.
 */
export function activePlans(plans: PaymentPlan[], now: Date): PaymentPlan[] {
  const t = now.getTime();
  return plans
    .filter((p) => p.is_active)
    .filter((p) => (p.available_from ? t >= Date.parse(p.available_from) : true))
    .filter((p) => (p.available_until ? t <= Date.parse(p.available_until) : true))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/** One materialized charge, ready to hand to `claim_event_seat`. */
export interface ChargeSeed {
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  due_at: string;
}

/**
 * Turns a plan's schedule template into the concrete charges for one
 * registration.
 *
 * Three rules, each of which exists because of a specific way this goes wrong:
 *
 *  * **The deposit is due now.** Its template `due_at` is null, because a fixed
 *    date for it would be right for the first registration and wrong for every
 *    one after. It resolves to the end of the payment hold.
 *
 *  * **A due date already in the past is pulled forward** to the end of the
 *    hold rather than being born overdue. Someone registering in November for a
 *    plan whose October instalment has passed owes it immediately — they do not
 *    owe it retroactively, and they should not receive an overdue notice for a
 *    charge that was created after the date it was late for. Refusing the
 *    registration outright would be the other option; that is what the plan's
 *    `available_until` is for, and it is the admin's to set.
 *
 *  * **A full plan is an instalment plan with one row.** No second code path,
 *    which is what lets "download a receipt" and "here is what you have paid"
 *    have one implementation each rather than two.
 */
export function buildSchedule(input: {
  plan: PaymentPlan;
  installments: PlanInstallment[];
  now: Date;
  holdMinutes: number;
}): ChargeSeed[] {
  const { plan, installments, now, holdMinutes } = input;

  if (installments.length === 0) {
    throw new TicketingValidationError(`Plan "${plan.name}" has no payment schedule`);
  }

  const holdEnd = new Date(now.getTime() + holdMinutes * 60_000).toISOString();
  const ordered = [...installments].sort((a, b) => a.seq - b.seq);

  const seeds = ordered.map((inst): ChargeSeed => {
    let dueAt: string;

    if (inst.is_deposit) {
      dueAt = holdEnd;
    } else if (inst.due_at) {
      dueAt = Date.parse(inst.due_at) <= now.getTime() ? holdEnd : inst.due_at;
    } else if (inst.due_offset_days !== null) {
      const target = new Date(now.getTime() + inst.due_offset_days * 86_400_000);
      dueAt = endOfDayManila(manilaDate(target));
    } else {
      throw new TicketingValidationError(
        `Instalment ${inst.seq} of "${plan.name}" has neither a due date nor an offset`,
      );
    }

    return {
      seq: inst.seq,
      label: inst.label,
      is_deposit: inst.is_deposit,
      amount_centavos: inst.amount_centavos,
      due_at: dueAt,
    };
  });

  // The same invariant the deferred trigger enforces in the database, checked
  // here so the caller gets a readable error instead of a constraint violation
  // at commit.
  const sum = seeds.reduce((acc, s) => acc + s.amount_centavos, 0);
  if (sum !== plan.total_centavos) {
    throw new TicketingValidationError(
      `Plan "${plan.name}" instalments sum to ${sum} but the plan total is ${plan.total_centavos}`,
    );
  }
  if (seeds.filter((s) => s.is_deposit).length !== 1) {
    throw new TicketingValidationError(
      `Plan "${plan.name}" must have exactly one deposit instalment`,
    );
  }

  return seeds;
}

export interface Charge {
  id: string;
  seq: number;
  label: string;
  is_deposit: boolean;
  amount_centavos: number;
  due_at: string;
  status: ChargeStatus;
}

/**
 * A charge that still represents money someone owes.
 *
 * `waived` and `void` are settled without being paid, which is exactly why they
 * are distinct enum values rather than both collapsing into `paid`: the money
 * summary must be able to say "forgiven" and "superseded" separately from
 * "received".
 */
export function isOutstanding(status: ChargeStatus): boolean {
  return status === 'scheduled' || status === 'awaiting_payment';
}

export function outstandingCentavos(charges: Charge[]): number {
  return charges
    .filter((c) => isOutstanding(c.status))
    .reduce((acc, c) => acc + c.amount_centavos, 0);
}

export function paidCentavos(charges: Charge[]): number {
  return charges
    .filter((c) => c.status === 'paid')
    .reduce((acc, c) => acc + c.amount_centavos, 0);
}

/**
 * The charge a registrant is allowed to pay next.
 *
 * Strictly the lowest unpaid sequence number. Paying the final instalment
 * before the second one is legal money and an illegible ledger — and it breaks
 * the reminder tiers, which assume the outstanding set is a suffix of the
 * schedule rather than an arbitrary subset.
 */
export function nextDueCharge(charges: Charge[]): Charge | null {
  return (
    [...charges]
      .filter((c) => isOutstanding(c.status))
      .sort((a, b) => a.seq - b.seq)[0] ?? null
  );
}

export function isFullySettled(charges: Charge[]): boolean {
  return charges.length > 0 && charges.every((c) => !isOutstanding(c.status));
}

// ---------------------------------------------------------------------------
// Cancellation refund tiers — Participant Agreement §III
// ---------------------------------------------------------------------------
// The retreat's written agreement (docs/participant-agreement.md, and the
// attached PDF) commits to three outcomes keyed on how far ahead of the
// retreat the cancellation lands. Before this, `cancel()` computed nothing and
// an admin free-typed a peso figure — which is how the signed terms and what
// actually happens drift apart. This is the one place that arithmetic lives.
//
//   * > 60 days before   — refund of payments received, LESS the deposit and
//                          any non-recoverable third-party cost already paid.
//   * 31–60 days before  — 50% of payments received, as a CREDIT toward
//                          another Hilom retreat within 12 months (not cash).
//                          The deposit and the remaining balance are forfeited.
//   * 30 days or fewer    — payments are non-refundable (incl. non-attendance
//     (or already started)  or early departure), "except where required by
//                          law" — which stays an admin override, not a branch.
//
// Everything is a suggestion the admin can override; the point is that the
// starting number matches the contract instead of a guess.

export type RefundTier = 'gt_60_days' | '31_to_60_days' | '30_days_or_fewer';

export interface RefundAssessment {
  tier: RefundTier;
  /** Whole days from `now` to the event start; negative once it has started. */
  daysUntilEvent: number;
  paidCentavos: number;
  depositCentavos: number;
  nonRecoverableCentavos: number;
  /** Cash to return. */
  refundCentavos: number;
  /** Credit toward another Hilom retreat within 12 months — tier 2 only. */
  creditCentavos: number;
  /** Retained by Hilom (paid − refund − credit). */
  forfeitCentavos: number;
  currency: string;
  /** One sentence, written to be shown to an admin and quoted to a registrant. */
  summary: string;
}

const DAY_MS = 86_400_000;

function pesos(centavos: number, currency: string): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(centavos / 100);
}

/**
 * The refund position for a cancellation, per Participant Agreement §III.
 *
 * Pure: `now` is a parameter so the 60- and 30-day edges are testable without
 * waiting for a calendar. `depositCentavos` is the amount of the deposit
 * charge (whether or not it is the only thing paid); `nonRecoverableCentavos`
 * is an admin-supplied figure for costs already forwarded to a third party and
 * defaults to zero.
 */
export function assessRefund(input: {
  eventStartsAt: string;
  now: Date;
  paidCentavos: number;
  depositCentavos: number;
  nonRecoverableCentavos?: number;
  currency?: string;
}): RefundAssessment {
  const currency = input.currency ?? 'PHP';
  const paid = requireWholeCentavos(input.paidCentavos, 'paidCentavos');
  const deposit = requireWholeCentavos(input.depositCentavos, 'depositCentavos');
  const nonRecoverable = requireWholeCentavos(
    input.nonRecoverableCentavos ?? 0,
    'nonRecoverableCentavos',
  );

  const startMs = Date.parse(input.eventStartsAt);
  if (Number.isNaN(startMs)) {
    throw new TicketingValidationError(`"${input.eventStartsAt}" is not a valid event start`);
  }
  const daysUntilEvent = Math.floor((startMs - input.now.getTime()) / DAY_MS);

  let tier: RefundTier;
  let refundCentavos: number;
  let creditCentavos: number;

  if (daysUntilEvent > 60) {
    tier = 'gt_60_days';
    refundCentavos = Math.max(0, paid - deposit - nonRecoverable);
    creditCentavos = 0;
  } else if (daysUntilEvent > 30) {
    tier = '31_to_60_days';
    refundCentavos = 0;
    // Half of what was received, rounded so credit + forfeit sum back exactly.
    creditCentavos = Math.round(paid / 2);
  } else {
    tier = '30_days_or_fewer';
    refundCentavos = 0;
    creditCentavos = 0;
  }

  const forfeitCentavos = paid - refundCentavos - creditCentavos;

  const summary = buildRefundSummary({
    tier,
    paid,
    deposit,
    nonRecoverable,
    refundCentavos,
    creditCentavos,
    forfeitCentavos,
    currency,
  });

  return {
    tier,
    daysUntilEvent,
    paidCentavos: paid,
    depositCentavos: deposit,
    nonRecoverableCentavos: nonRecoverable,
    refundCentavos,
    creditCentavos,
    forfeitCentavos,
    currency,
    summary,
  };
}

function requireWholeCentavos(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TicketingValidationError(`${field} must be a whole number of centavos`);
  }
  return value;
}

function buildRefundSummary(x: {
  tier: RefundTier;
  paid: number;
  deposit: number;
  nonRecoverable: number;
  refundCentavos: number;
  creditCentavos: number;
  forfeitCentavos: number;
  currency: string;
}): string {
  const c = x.currency;
  if (x.tier === 'gt_60_days') {
    const less =
      x.nonRecoverable > 0
        ? `, less the ${pesos(x.deposit, c)} deposit and ${pesos(x.nonRecoverable, c)} in non-recoverable costs`
        : `, less the ${pesos(x.deposit, c)} deposit`;
    return (
      `More than 60 days before the retreat: ${pesos(x.refundCentavos, c)} refunded ` +
      `of ${pesos(x.paid, c)} paid${less}.`
    );
  }
  if (x.tier === '31_to_60_days') {
    return (
      `31–60 days before the retreat: ${pesos(x.creditCentavos, c)} (50% of ${pesos(x.paid, c)} paid) ` +
      `credited once toward another Hilom retreat within 12 months. ` +
      `The deposit and the balance are forfeited; no cash refund.`
    );
  }
  return (
    `30 days or fewer before the retreat: payments are non-refundable, ` +
    `so ${pesos(x.paid, c)} is forfeited (except where required by law).`
  );
}

/**
 * Registrant fields an event may ask for beyond name, email and phone.
 *
 * A whitelist rather than free-form keys, because these end up in a JSONB blob
 * that is exported to CSV and handed to a venue: an open key space becomes an
 * open PII space, and nobody notices until the spreadsheet arrives.
 */
export const REGISTRANT_FIELDS = [
  'dietary',
  'emergency_contact',
  'emergency_phone',
  'room_preference',
  'medical_notes',
  'accessibility_needs',
  'pronouns',
  'how_did_you_hear',
] as const;

export type RegistrantField = (typeof REGISTRANT_FIELDS)[number];

const FIELD_MAX_LENGTH = 500;

export function isRegistrantField(key: string): key is RegistrantField {
  return (REGISTRANT_FIELDS as readonly string[]).includes(key);
}

/**
 * Validates the per-event extras against what the event actually asks for.
 *
 * Returns only the requested keys, trimmed and length-capped. Anything the
 * event did not ask for is dropped rather than rejected — a stale form field
 * from a cached page should not cost someone their seat, and silently ignoring
 * it is safe precisely because the whitelist is closed.
 */
export function validateRegistrantDetails(
  requestedFields: string[],
  submitted: Record<string, unknown>,
): Record<string, string> {
  const wanted = requestedFields.filter(isRegistrantField);
  const out: Record<string, string> = {};

  for (const key of wanted) {
    const raw = submitted[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim().slice(0, FIELD_MAX_LENGTH);
    if (value) out[key] = value;
  }

  return out;
}

export interface RegistrantInput {
  name: string;
  email: string;
  phone?: string;
  details: Record<string, string>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Validates the attendee block.
 *
 * Note that the attendee's email is deliberately not required to match the
 * buyer's: someone booking a retreat for their partner is ordinary, and the
 * transfer feature depends on the two being separable.
 */
export function validateRegistrant(input: {
  requestedFields: string[];
  body: Record<string, unknown>;
}): RegistrantInput {
  const { requestedFields, body } = input;

  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw new TicketingValidationError('Who is attending? A name is required.');

  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 320);
  if (!EMAIL_RE.test(email)) {
    throw new TicketingValidationError('That does not look like an email address.');
  }

  const phoneRaw = String(body.phone ?? '').trim().slice(0, 40);

  const details = validateRegistrantDetails(
    requestedFields,
    (body.details ?? {}) as Record<string, unknown>,
  );

  return { name, email, phone: phoneRaw || undefined, details };
}

/**
 * Whether the registration window is open, judged only on the event's own
 * configuration.
 *
 * Capacity is deliberately not considered here: seats are counted inside
 * `claim_event_seat` under a row lock, and any count read outside that lock is
 * stale the moment it is returned. This answers "is the door open", not "is
 * there room" — the public endpoint reports the two separately, and only the
 * database gets to decide the second one.
 */
export function registrationOpen(input: {
  ticketingEnabled: boolean;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  now: Date;
}): boolean {
  const { ticketingEnabled, status, opensAt, closesAt, now } = input;
  if (!ticketingEnabled || status !== 'published') return false;
  const t = now.getTime();
  if (opensAt && t < Date.parse(opensAt)) return false;
  if (closesAt && t > Date.parse(closesAt)) return false;
  return true;
}

/**
 * Whether a deposit cleared inside its plan's availability window.
 *
 * The product rule is that the instalment plan is available if the down payment
 * *clears* by 30 September — but a QRPh payment begun at 23:52 can clear at
 * 00:03. Neither possible automatic answer is acceptable: voiding a paid seat
 * over a minute of clock is indefensible, and silently honouring it grants a
 * ₱5,000 discount nobody approved. So the payment is always accepted and this
 * returns whether a human needs to look.
 */
export function depositClearedLate(input: {
  planKind: PaymentPlanKind;
  availableUntil: string | null;
  clearedAt: Date;
}): boolean {
  const { planKind, availableUntil, clearedAt } = input;
  if (planKind !== 'installment' || !availableUntil) return false;
  return clearedAt.getTime() > Date.parse(availableUntil);
}

// ---------------------------------------------------------------------------
// Admin write-side validation
// ---------------------------------------------------------------------------
// The plan builder is the one admin screen where a typo costs real money, so
// these checks are deliberately strict and their messages are written to be
// read by the person who made the mistake rather than by a developer.
//
// The database enforces the same invariants (0016's deferred totals trigger),
// but a constraint violation surfacing at commit says "check_violation" and
// names a plan by uuid. This says which instalment is wrong and by how much.

export interface InstallmentInput {
  seq: number;
  label: string;
  amount_centavos: number;
  due_at: string | null;
  due_offset_days: number | null;
  is_deposit: boolean;
}

export interface PlanInput {
  id?: string;
  name: string;
  description: string | null;
  kind: PaymentPlanKind;
  total_centavos: number;
  currency: string;
  available_from: string | null;
  available_until: string | null;
  is_active: boolean;
  sort_order: number;
  installments: InstallmentInput[];
}

/**
 * Accepts either a plain Manila calendar date or a full instant.
 *
 * Admins type dates; machines round-trip instants. Taking `YYYY-MM-DD` and
 * resolving it here is what keeps a due date from silently becoming the
 * admin's browser midnight — the specific timezone failure this system is most
 * exposed to, because everyone configuring it sits in Manila and the servers
 * do not.
 */
function resolveEdge(raw: unknown, edge: 'start' | 'end', field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === 'start' ? startOfDayManila(value) : endOfDayManila(value);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TicketingValidationError(`${field} is not a valid date`);
  }
  return parsed.toISOString();
}

function wholeCentavos(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new TicketingValidationError(`${field} must be a whole number of centavos`);
  }
  return n;
}

function text(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw).trim().slice(0, max) || null;
}

/**
 * Validates one payment plan and its schedule.
 *
 * The two invariants worth naming: the instalments must sum to the plan total,
 * and exactly one of them must be the deposit. Both are re-checked by the
 * database, and both are the reason the ₱8,333.35 × 3 version of this retreat
 * would have been caught before anyone paid it.
 */
export function validatePlan(raw: unknown, index: number): PlanInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const where = `Plan ${index + 1}`;

  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw new TicketingValidationError(`${where} needs a name.`);

  const kind = String(body.kind ?? '');
  if (kind !== 'full' && kind !== 'installment') {
    throw new TicketingValidationError(`${where} ("${name}") must be either a full payment or an instalment plan.`);
  }

  const total = wholeCentavos(body.total_centavos, `${where} ("${name}") total`);

  const availableFrom = resolveEdge(body.available_from, 'start', `${where} available-from`);
  const availableUntil = resolveEdge(body.available_until, 'end', `${where} available-until`);
  if (availableFrom && availableUntil && Date.parse(availableFrom) > Date.parse(availableUntil)) {
    throw new TicketingValidationError(`${where} ("${name}") closes before it opens.`);
  }

  const rawInstallments = Array.isArray(body.installments) ? body.installments : [];
  if (rawInstallments.length === 0) {
    throw new TicketingValidationError(`${where} ("${name}") has no payments in its schedule.`);
  }
  if (kind === 'full' && rawInstallments.length > 1) {
    throw new TicketingValidationError(
      `${where} ("${name}") is a pay-in-full plan, so it can only have one payment.`,
    );
  }

  const seen = new Set<number>();
  const installments = rawInstallments.map((item, i): InstallmentInput => {
    const inst = (item ?? {}) as Record<string, unknown>;
    const seq = Number(inst.seq ?? i + 1);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new TicketingValidationError(`${where} ("${name}") has a payment with no position in the schedule.`);
    }
    if (seen.has(seq)) {
      throw new TicketingValidationError(`${where} ("${name}") has two payments numbered ${seq}.`);
    }
    seen.add(seq);

    const label = String(inst.label ?? '').trim().slice(0, 120);
    if (!label) throw new TicketingValidationError(`${where} ("${name}") payment ${seq} needs a label.`);

    const amount = wholeCentavos(inst.amount_centavos, `${where} ("${name}") payment ${seq}`);
    if (amount <= 0) {
      throw new TicketingValidationError(`${where} ("${name}") payment ${seq} must be more than zero.`);
    }

    const isDeposit = Boolean(inst.is_deposit);

    // The deposit is due at registration, so it carries no template date. Any
    // other payment must say when it falls due, one way or the other.
    let dueAt: string | null = null;
    let dueOffsetDays: number | null = null;

    if (!isDeposit) {
      dueAt = resolveEdge(inst.due_date ?? inst.due_at, 'end', `${where} ("${name}") payment ${seq} due date`);
      if (inst.due_offset_days !== undefined && inst.due_offset_days !== null && inst.due_offset_days !== '') {
        const off = Number(inst.due_offset_days);
        if (!Number.isInteger(off) || off < 0) {
          throw new TicketingValidationError(
            `${where} ("${name}") payment ${seq} has an invalid "days after registration" value.`,
          );
        }
        dueOffsetDays = off;
      }
      if (dueAt && dueOffsetDays !== null) {
        throw new TicketingValidationError(
          `${where} ("${name}") payment ${seq} has both a fixed date and a days-after-registration offset — pick one.`,
        );
      }
      if (!dueAt && dueOffsetDays === null) {
        throw new TicketingValidationError(
          `${where} ("${name}") payment ${seq} needs either a due date or a number of days after registration.`,
        );
      }
    }

    return { seq, label, amount_centavos: amount, due_at: dueAt, due_offset_days: dueOffsetDays, is_deposit: isDeposit };
  });

  const deposits = installments.filter((i) => i.is_deposit).length;
  if (deposits !== 1) {
    throw new TicketingValidationError(
      deposits === 0
        ? `${where} ("${name}") needs one payment marked as the deposit — the one taken at registration.`
        : `${where} ("${name}") has ${deposits} payments marked as the deposit; there can only be one.`,
    );
  }

  const sum = installments.reduce((acc, i) => acc + i.amount_centavos, 0);
  if (sum !== total) {
    const diff = sum - total;
    throw new TicketingValidationError(
      `${where} ("${name}") payments add up to ₱${(sum / 100).toFixed(2)} but the plan total is ` +
        `₱${(total / 100).toFixed(2)} — ${diff > 0 ? 'over' : 'short'} by ₱${(Math.abs(diff) / 100).toFixed(2)}.`,
    );
  }

  return {
    ...(typeof body.id === 'string' && body.id ? { id: body.id } : {}),
    name,
    description: text(body.description, 1000),
    kind,
    total_centavos: total,
    currency: String(body.currency ?? 'PHP').slice(0, 3).toUpperCase(),
    available_from: availableFrom,
    available_until: availableUntil,
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
    sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : index,
    installments,
  };
}

/** Validates the whole plan set an admin submitted for one event. */
export function validatePlans(raw: unknown): PlanInput[] {
  if (!Array.isArray(raw)) {
    throw new TicketingValidationError('Expected a list of payment plans.');
  }
  const plans = raw.map(validatePlan);

  const names = new Set<string>();
  for (const plan of plans) {
    const key = plan.name.toLowerCase();
    if (names.has(key)) {
      throw new TicketingValidationError(
        `Two plans are both called "${plan.name}" — registrants pick by name, so they have to differ.`,
      );
    }
    names.add(key);
  }

  return plans;
}

/**
 * Package instalments (0077): the rules, with no I/O so they can be tested.
 *
 * A plan is a list of payments, each with an amount and the session it must be
 * paid before. The first is always due at checkout (`due_session` 1). Amounts
 * add up to the package price exactly.
 */

export interface PlanInstallment {
  amount_centavos: number;
  due_session: number;
}

export type PlanResult = { ok: true; plan: PlanInstallment[] } | { ok: false; error: string };

/** Validates and normalises a plan a facilitator entered for a package service. */
export function validateInstallmentPlan(
  raw: unknown,
  priceCentavos: number,
  sessionsCount: number,
): PlanResult {
  if (raw === null || raw === undefined) return { ok: true, plan: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'The instalment plan must be a list of payments' };
  if (raw.length === 0) return { ok: true, plan: [] };
  if (raw.length < 2) return { ok: false, error: 'An instalment plan needs at least 2 payments' };
  if (raw.length > 12) return { ok: false, error: 'An instalment plan can have at most 12 payments' };
  if (sessionsCount < 2) return { ok: false, error: 'Instalments are only for packages of 2 or more sessions' };

  const plan: PlanInstallment[] = [];
  for (const [i, item] of raw.entries()) {
    const r = item as Record<string, unknown>;
    const amount = Number(r?.amount_centavos);
    const due = Number(r?.due_session);
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: `Payment ${i + 1} needs an amount above zero` };
    if (!Number.isInteger(due) || due < 1 || due > sessionsCount) {
      return { ok: false, error: `Payment ${i + 1} must be due before a session between 1 and ${sessionsCount}` };
    }
    plan.push({ amount_centavos: amount, due_session: due });
  }
  if (plan[0]!.due_session !== 1) return { ok: false, error: 'The first payment is paid at checkout, before session 1' };
  for (let i = 1; i < plan.length; i++) {
    if (plan[i]!.due_session < plan[i - 1]!.due_session) {
      return { ok: false, error: 'Payments must be in session order' };
    }
  }
  const total = plan.reduce((s, p) => s + p.amount_centavos, 0);
  if (total !== priceCentavos) {
    return {
      ok: false,
      error: `Payments add up to ₱${(total / 100).toFixed(2)} but the package costs ₱${(priceCentavos / 100).toFixed(2)}`,
    };
  }
  return { ok: true, plan };
}

/**
 * An even plan for the editor's "split into N payments" starting point: equal
 * amounts (the remainder on the first payment), due before evenly spaced
 * sessions starting with session 1.
 */
export function suggestInstallmentPlan(priceCentavos: number, sessionsCount: number, payments: number): PlanInstallment[] {
  const n = Math.max(2, Math.min(payments, 12, sessionsCount));
  const base = Math.floor(priceCentavos / n / 100) * 100; // whole pesos
  const first = priceCentavos - base * (n - 1);
  return Array.from({ length: n }, (_, i) => ({
    amount_centavos: i === 0 ? first : base,
    due_session: 1 + Math.floor((i * sessionsCount) / n),
  }));
}

export interface ChargeDraft {
  seq: number;
  label: string;
  amount_centavos: number;
  due_session: number;
  platform_fee_centavos: number;
  facilitator_net_centavos: number;
}

/**
 * The charges for one purchase. The platform fee is split across payments by
 * running total, so the per-payment fees add back to the package's fee exactly.
 */
export function chargesForPlan(plan: PlanInstallment[], platformFeeCentavos: number): ChargeDraft[] {
  const price = plan.reduce((s, p) => s + p.amount_centavos, 0);
  let runningAmount = 0;
  let feeSoFar = 0;
  return plan.map((p, i) => {
    runningAmount += p.amount_centavos;
    const feeTarget = price > 0 ? Math.round((platformFeeCentavos * runningAmount) / price) : 0;
    const fee = feeTarget - feeSoFar;
    feeSoFar = feeTarget;
    return {
      seq: i + 1,
      label: `Payment ${i + 1} of ${plan.length}`,
      amount_centavos: p.amount_centavos,
      due_session: p.due_session,
      platform_fee_centavos: fee,
      facilitator_net_centavos: p.amount_centavos - fee,
    };
  });
}

/**
 * When a charge is due: the start of the package's `due_session`-th live
 * session by start time, or null when that session is not scheduled yet.
 */
export function chargeDueAt(dueSession: number, sessionStartsSorted: string[]): string | null {
  return sessionStartsSorted[dueSession - 1] ?? null;
}

export type ReminderTier = '7d' | '3d' | 'day_of';

/** The calendar date in Manila, which is when "today" means anything here. */
function manilaDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

/**
 * The one reminder that applies right now for a payment due at `dueAt`:
 * the day of the session, else within 3 days, else within 7 days. Only the
 * most urgent tier is returned, so a package bought two days before a session
 * gets one reminder rather than two at once. Null when nothing applies,
 * including once the session has started.
 */
export function reminderTierFor(dueAt: Date, now: Date): ReminderTier | null {
  if (now >= dueAt) return null;
  if (manilaDate(now) === manilaDate(dueAt)) return 'day_of';
  const ms = dueAt.getTime() - now.getTime();
  if (ms <= 3 * 86_400_000) return '3d';
  if (ms <= 7 * 86_400_000) return '7d';
  return null;
}

export type OutstandingStatus = 'scheduled' | 'awaiting_payment';
export const OUTSTANDING: ReadonlySet<string> = new Set(['scheduled', 'awaiting_payment']);

/** paid / pending / overdue, as shown to the client and the facilitator. */
export function chargeState(status: string, dueAt: string | null, now: Date): 'paid' | 'pending' | 'overdue' | 'waived' | 'void' {
  if (status === 'paid' || status === 'refunded') return 'paid';
  if (status === 'waived') return 'waived';
  if (status === 'void') return 'void';
  if (dueAt && new Date(dueAt) <= now) return 'overdue';
  return 'pending';
}

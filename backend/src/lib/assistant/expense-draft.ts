/**
 * Expense drafting for the admin assistant — pure validation, no I/O.
 *
 * The assistant never writes. It calls `draft_expense` with whatever the admin
 * has told it so far; this checks every field against real data (categories,
 * accounts, events, closed months, likely duplicates) and returns either a
 * complete draft or the questions still to ask. A complete draft is stored on
 * the run and shown to the admin as a confirmation card; only the admin's own
 * Save — through the Finance expenses endpoint, under their identity — records
 * anything.
 */
import { EXPENSE_CATEGORIES } from '../finance-domain.js';

export interface DraftInput {
  incurred_on?: string;
  vendor?: string;
  description?: string;
  category?: string;
  amount_php?: number | string;
  vat_php?: number | string;
  payment_method?: string;
  /** Account name or id the company paid from. */
  account?: string;
  /** Someone who paid personally (becomes a reimbursement owed to them). */
  paid_by_person?: string;
  /** Event title or id this cost belongs to. */
  event?: string;
  notes?: string;
}

export interface DraftContext {
  today: string; // YYYY-MM-DD, Manila
  accounts: { id: string; name: string; is_active: boolean }[];
  events: { id: string; title: string; starts_at: string | null }[];
  closedMonths: Set<string>;
  recentExpenses: { id: string; incurred_on: string; vendor: string; amount_centavos: number; status: string }[];
}

export interface ExpenseDraft {
  incurred_on: string;
  vendor: string;
  description: string;
  category: string;
  amount_centavos: number;
  vat_centavos: number;
  payment_method: string | null;
  account_id: string | null;
  account_name: string | null;
  paid_by: string; // 'company' or a person's name
  event_id: string | null;
  event_title: string | null;
  notes: string | null;
}

export interface DraftResult {
  status: 'ready' | 'needs_info';
  draft: Partial<ExpenseDraft>;
  /** Questions the assistant must ask before the draft is complete. */
  questions: string[];
  /** Things to point out to the admin; they do not block the draft. */
  warnings: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function toCentavos(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₱,\s]|php/gi, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Exact (case/punctuation-insensitive) match first, then unique substring match. */
export function matchOne<T>(query: string, items: T[], key: (t: T) => string, id?: (t: T) => string): { match: T | null; candidates: T[] } {
  const q = norm(query);
  if (!q) return { match: null, candidates: [] };
  if (id) {
    const byId = items.find((t) => id(t) === query.trim());
    if (byId) return { match: byId, candidates: [byId] };
  }
  const exact = items.filter((t) => norm(key(t)) === q);
  if (exact.length === 1) return { match: exact[0]!, candidates: exact };
  const partial = items.filter((t) => norm(key(t)).includes(q) || q.includes(norm(key(t))));
  if (partial.length === 1) return { match: partial[0]!, candidates: partial };
  return { match: null, candidates: exact.length ? exact : partial };
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

export function validateExpenseDraft(input: DraftInput, ctx: DraftContext): DraftResult {
  const questions: string[] = [];
  const warnings: string[] = [];
  const draft: Partial<ExpenseDraft> = {};

  // Date paid
  const day = input.incurred_on?.trim();
  if (!day) questions.push('What date was it paid (or is it due, if not yet paid)?');
  else if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) questions.push(`"${day}" isn't a date I can use — what date was it paid (YYYY-MM-DD)?`);
  else {
    draft.incurred_on = day;
    if (ctx.closedMonths.has(day.slice(0, 7))) {
      questions.push(`${day.slice(0, 7)} is a closed month, so an expense can't be dated in it. Should it be dated in an open month (the correction then shows there), or does the month need reopening on Profit & loss?`);
    }
    if (day > ctx.today) warnings.push(`It's dated in the future (${day}). If it isn't paid yet, save it as a draft and approve it once paid.`);
  }

  // Vendor and description
  const vendor = input.vendor?.trim();
  if (!vendor) questions.push('Who was it paid to (the vendor or payee)?');
  else draft.vendor = vendor.slice(0, 200);
  draft.description = (input.description ?? '').trim().slice(0, 1000);
  if (!draft.description) warnings.push('No description — a few words on what it was for helps later.');

  // Category
  const cat = input.category?.trim();
  if (!cat) questions.push(`Which category? ${EXPENSE_CATEGORIES.join(' · ')}`);
  else {
    const { match } = matchOne(cat, [...EXPENSE_CATEGORIES], (c) => c);
    if (match) draft.category = match;
    else questions.push(`"${cat}" isn't one of the categories. Which fits: ${EXPENSE_CATEGORIES.join(' · ')}?`);
  }

  // Amount and VAT
  const amount = toCentavos(input.amount_php);
  if (amount === null) questions.push('How much was paid, in pesos?');
  else if (amount <= 0) questions.push('The amount has to be more than zero — how much was paid?');
  else draft.amount_centavos = amount;
  const vat = toCentavos(input.vat_php) ?? 0;
  if (vat < 0) questions.push('VAT can’t be negative — how much VAT was included, if any?');
  else if (amount !== null && vat > amount) questions.push('The VAT is more than the amount — how much VAT was included?');
  else draft.vat_centavos = vat;

  draft.payment_method = input.payment_method?.trim().slice(0, 100) || null;

  // Who paid
  const person = input.paid_by_person?.trim();
  const accountQ = input.account?.trim();
  const active = ctx.accounts.filter((a) => a.is_active);
  if (person && accountQ) {
    questions.push(`Was it paid from ${accountQ}, or personally by ${person}? (Personally paid means the company owes ${person} back.)`);
  } else if (person) {
    if (person.toLowerCase() === 'company') questions.push('Which company account was it paid from?');
    else {
      draft.paid_by = person.slice(0, 100);
      draft.account_id = null;
      draft.account_name = null;
      warnings.push(`${person} paid personally, so it will be added to what the company owes ${person} (Reimbursements).`);
    }
  } else if (accountQ) {
    const { match, candidates } = matchOne(accountQ, active, (a) => a.name, (a) => a.id);
    if (match) {
      draft.paid_by = 'company';
      draft.account_id = match.id;
      draft.account_name = match.name;
    } else if (!active.length) {
      draft.paid_by = 'company';
      draft.account_id = null;
      draft.account_name = null;
      warnings.push('No money accounts are set up yet (Finance → Accounts), so it will be saved as paid by the company with no account.');
    } else {
      questions.push(
        candidates.length > 1
          ? `Which account: ${candidates.map((a) => a.name).join(' or ')}?`
          : `I can't find an account called "${accountQ}". Which one: ${active.map((a) => a.name).join(' · ')}?`,
      );
    }
  } else if (!active.length) {
    questions.push('Did the company pay it, or did someone pay personally (so the company owes them back)?');
  } else {
    questions.push(`Which account paid it (${active.map((a) => a.name).join(' · ')}), or did someone pay personally?`);
  }

  // Event (optional)
  const ev = input.event?.trim();
  if (ev) {
    const { match, candidates } = matchOne(ev, ctx.events, (e) => e.title, (e) => e.id);
    if (match) {
      draft.event_id = match.id;
      draft.event_title = match.title;
    } else if (candidates.length > 1) {
      questions.push(`Which event: ${candidates.slice(0, 6).map((e) => `${e.title}${e.starts_at ? ` (${e.starts_at.slice(0, 10)})` : ''}`).join(' · ')}?`);
    } else {
      warnings.push(`No event matches "${ev}", so it won't be linked to one.`);
      draft.event_id = null;
      draft.event_title = null;
    }
  } else {
    draft.event_id = null;
    draft.event_title = null;
  }

  draft.notes = input.notes?.trim().slice(0, 2000) || null;

  // Likely duplicates
  if (draft.amount_centavos && draft.vendor && draft.incurred_on) {
    const v = norm(draft.vendor);
    for (const e of ctx.recentExpenses) {
      if (e.status === 'void' || e.amount_centavos !== draft.amount_centavos) continue;
      const ev2 = norm(e.vendor);
      if (!(ev2.includes(v) || v.includes(ev2))) continue;
      if (daysBetween(e.incurred_on, draft.incurred_on) > 14) continue;
      warnings.push(`Possible duplicate: ${e.vendor} ₱${(e.amount_centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} is already recorded on ${e.incurred_on}${e.status === 'draft' ? ' (as a draft)' : ''}. Make sure this is a separate payment.`);
    }
  }

  warnings.push('Attach the receipt on the card before saving if you have one.');
  return { status: questions.length ? 'needs_info' : 'ready', draft, questions, warnings };
}

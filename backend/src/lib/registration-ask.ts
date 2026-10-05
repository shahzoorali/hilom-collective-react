/**
 * The registration "ask" on a facilitator's event proposal (0068).
 *
 * Parsed here, not in facilitator-portal.ts, so the rules are testable without a
 * database. Nothing returned from this file turns ticketing on: it is stored as
 * `proposed_*` columns for the admin to read, and the admin's own editor is what
 * writes capacity, plans and close dates.
 */
import { FacilitatorInputError } from './facilitator-input.js';

export type RegistrationMode = 'listing' | 'hilom';

export interface RegistrationAsk {
  proposed_registration: RegistrationMode | null;
  proposed_price_centavos: number | null;
  proposed_capacity: number | null;
  proposed_registration_closes_on: string | null;
}

const EMPTY: RegistrationAsk = {
  proposed_registration: null,
  proposed_price_centavos: null,
  proposed_capacity: null,
  proposed_registration_closes_on: null,
};

const given = (v: unknown) => v !== null && v !== undefined && v !== '';

/**
 * Returns the ask columns to write, or null when the body does not mention
 * registration at all, so a save from a form that knows nothing about it
 * cannot wipe an ask someone already made.
 */
export function parseRegistrationAsk(body: Record<string, unknown>): RegistrationAsk | null {
  if (!('proposed_registration' in body)) return null;

  const mode = body.proposed_registration;
  if (mode === null || mode === '') return { ...EMPTY };
  if (mode !== 'listing' && mode !== 'hilom') {
    throw new FacilitatorInputError('Choose listing only or registration through Hilom.');
  }
  // A listing-only event has no price, places or deadline to remember.
  if (mode === 'listing') return { ...EMPTY, proposed_registration: 'listing' };

  const price = body.proposed_price_centavos;
  const capacity = body.proposed_capacity;
  const closes = body.proposed_registration_closes_on;

  if (given(price) && (!Number.isInteger(Number(price)) || Number(price) <= 0)) {
    throw new FacilitatorInputError('The price has to be more than zero.');
  }
  if (given(capacity)) {
    const n = Number(capacity);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      throw new FacilitatorInputError('Places has to be a whole number of at least 1.');
    }
  }
  if (given(closes) && (typeof closes !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(closes) || Number.isNaN(Date.parse(closes)))) {
    throw new FacilitatorInputError('The registration deadline has to be a date.');
  }

  return {
    proposed_registration: 'hilom',
    proposed_price_centavos: given(price) ? Number(price) : null,
    proposed_capacity: given(capacity) ? Number(capacity) : null,
    proposed_registration_closes_on: given(closes) ? String(closes) : null,
  };
}

/** What an admin cannot review the absence of, checked at submit. */
export function missingForSubmit(
  ask: Pick<RegistrationAsk, 'proposed_registration' | 'proposed_price_centavos' | 'proposed_capacity'> & {
    link_url?: string | null;
  },
): string[] {
  if (ask.proposed_registration === 'hilom') {
    return [
      ask.proposed_price_centavos == null && 'a price',
      ask.proposed_capacity == null && 'how many places',
    ].filter((m): m is string => typeof m === 'string');
  }
  if (ask.proposed_registration === 'listing' && !ask.link_url) return ['a registration link'];
  return [];
}

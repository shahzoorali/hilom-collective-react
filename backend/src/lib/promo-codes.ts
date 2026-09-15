/**
 * Resolves a promo code against a price, shared by the checkout preview and
 * the authoritative session-creation path so the two can never disagree about
 * how much a code takes off.
 *
 * Never trusts a discount amount from the client — only the code string. The
 * row (type, value, active, expiry) is read fresh from the database on every
 * call rather than cached, because a code an admin just deactivated must stop
 * working on the very next checkout attempt, not whenever a Lambda container
 * happens to recycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export class PromoCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromoCodeError';
  }
}

interface PromoCodeRow {
  id: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  is_active: boolean;
  expires_at: string | null;
}

export interface ResolvedPromoCode {
  promoCodeId: string;
  code: string;
  discountCentavos: number;
  finalAmountCentavos: number;
}

export async function resolvePromoCode(
  supabase: SupabaseClient,
  rawCode: string,
  amountCentavos: number,
): Promise<ResolvedPromoCode> {
  const code = rawCode.trim().toUpperCase();
  if (!code) throw new PromoCodeError('Enter a promo code');

  const { data: promo, error } = await supabase
    .from('promo_codes')
    .select('id, code, discount_type, discount_value, is_active, expires_at')
    .eq('code', code)
    .maybeSingle<PromoCodeRow>();
  if (error) throw error;

  if (!promo || !promo.is_active) throw new PromoCodeError('That promo code is not valid');
  if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
    throw new PromoCodeError('That promo code has expired');
  }

  const discountCentavos =
    promo.discount_type === 'percent'
      ? Math.round((amountCentavos * promo.discount_value) / 100)
      : Math.min(promo.discount_value, amountCentavos);

  return {
    promoCodeId: promo.id,
    code: promo.code,
    discountCentavos,
    finalAmountCentavos: amountCentavos - discountCentavos,
  };
}

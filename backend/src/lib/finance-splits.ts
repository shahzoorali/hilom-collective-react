/**
 * Loading revenue_split_rules for an event charge. The arithmetic is in
 * finance-domain.ts (`pickRule`, `resolveSplit`); this is only the I/O, shared
 * by the webhook's split step (registration-fulfillment.ts) and the admin
 * "apply to unpaid charges" action (admin-finance.ts) so both resolve a split
 * the same way.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { pickRule, resolveSplit, type ResolvedSplit, type SplitRule } from './finance-domain.js';

export interface EventSplitContext {
  id: string;
  facilitator_id: string | null;
  series_id: string | null;
  platform_fee_bps: number | null;
}

export const SPLIT_RULE_COLUMNS = 'id, scope, scope_id, kind, bps, flat_facilitator_centavos, fee_borne_by';

export async function loadEventSplitContext(supabase: SupabaseClient, eventId: string): Promise<EventSplitContext | null> {
  const { data, error } = await supabase
    .from('events')
    .select('id, facilitator_id, series_id, platform_fee_bps')
    .eq('id', eventId)
    .maybeSingle<EventSplitContext>();
  if (error) throw error;
  return data;
}

export async function ruleForEvent(supabase: SupabaseClient, event: EventSplitContext): Promise<SplitRule | null> {
  const scopeIds = [event.id, event.series_id, event.facilitator_id].filter((x): x is string => !!x);
  const { data, error } = await supabase
    .from('revenue_split_rules')
    .select(SPLIT_RULE_COLUMNS)
    .is('voided_at', null)
    .in('scope_id', scopeIds);
  if (error) throw error;
  return pickRule((data ?? []) as SplitRule[], {
    eventId: event.id,
    seriesId: event.series_id,
    facilitatorId: event.facilitator_id,
  });
}

/**
 * The split for a charge on this event, or null when the money is Hilom's.
 * No host means Hilom's own programme whatever the rules say.
 */
export async function splitForEventCharge(
  supabase: SupabaseClient,
  event: EventSplitContext,
  amountCentavos: number,
): Promise<ResolvedSplit | null> {
  if (!event.facilitator_id) return null;
  const rule = await ruleForEvent(supabase, event);
  return resolveSplit(amountCentavos, rule, event.platform_fee_bps);
}

/**
 * The admin audit trail.
 *
 * Every action that moves money or changes what someone owes writes a row here.
 * The table is append-only by grant (0017_registration_reminders_audit.sql):
 * service_role holds select and insert and nothing else, so nothing in this
 * codebase can rewrite or erase history even by mistake.
 *
 * **On what the actor means.** These endpoints authorize with the shared admin
 * key (isAuthorizedAdmin, http.ts:83), which identifies an office rather than a
 * person. `actor_label` is therefore an *attestation*: a name the operator
 * typed into the admin UI, sent in `x-admin-actor`, corroborated only by the
 * request IP. Anyone holding the key can type any name. That is a deliberate,
 * recorded limitation, not an oversight — `actor_source` marks it so no reader
 * of the log is misled, and the admin UI labels it the same way.
 *
 * It is still worth recording. "Someone marked this ₱8,333 paid" and "Rina's
 * session marked this ₱8,333 paid at 14:02 from 112.198.x.x" are different
 * amounts of help when you are reconciling a bank statement on a Tuesday. What
 * it is not is evidence in a dispute; for that the endpoints need to move to
 * isAdminCaller (http.ts:123), which already accepts a verified Cognito token.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getSupabase } from './supabase.js';

export type AuditActorSource = 'shared_key' | 'cognito' | 'system';

export interface AuditActor {
  source: AuditActorSource;
  label: string;
  sub?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: string;
  targetTable: string;
  targetId?: string | null;
  eventId?: string | null;
  /** Only for actions that moved a number. Null keeps this out of the money view. */
  amountCentavos?: number | null;
  currency?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
}

const UNNAMED = 'unnamed operator';

/**
 * Builds the actor for an admin request.
 *
 * `x-admin-actor` is optional. A missing one is recorded as an unnamed operator
 * rather than rejected — refusing the write would mean an admin who cleared
 * their session storage cannot mark a payment received, which trades a real
 * operational failure for a marginal gain in a field that was never verified
 * to begin with.
 */
export function actorFromEvent(event: APIGatewayProxyEventV2): AuditActor {
  const headers = event.headers ?? {};
  const claimed = String(headers['x-admin-actor'] ?? headers['X-Admin-Actor'] ?? '').trim();
  const agent = String(headers['user-agent'] ?? headers['User-Agent'] ?? '').slice(0, 500);

  return {
    source: 'shared_key',
    label: claimed.slice(0, 120) || UNNAMED,
    ip: event.requestContext?.http?.sourceIp ?? null,
    userAgent: agent || null,
  };
}

/** The actor for something a registrant did to their own registration. */
export function selfActor(email: string, event: APIGatewayProxyEventV2): AuditActor {
  return {
    source: 'system',
    label: email,
    ip: event.requestContext?.http?.sourceIp ?? null,
    userAgent: String(event.headers?.['user-agent'] ?? '').slice(0, 500) || null,
  };
}

/** The actor for a scheduled job. */
export const SYSTEM_ACTOR: AuditActor = { source: 'system', label: 'sweep' };

/**
 * Writes one audit row.
 *
 * **Never throws, and never blocks the operation it describes.** An audit write
 * failing must not roll back a payment that was already marked received — the
 * money moved either way, and losing the record of it is strictly better than
 * losing the record *and* the fact. Failures are logged loudly instead, because
 * a silently empty audit trail is worse than a noisy one.
 */
export async function recordAudit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase.from('admin_audit_log').insert({
      actor_source: actor.source,
      actor_label: actor.label,
      actor_sub: actor.sub ?? null,
      source_ip: actor.ip ?? null,
      user_agent: actor.userAgent ?? null,
      action: entry.action,
      target_table: entry.targetTable,
      target_id: entry.targetId ?? null,
      event_id: entry.eventId ?? null,
      amount_centavos: entry.amountCentavos ?? null,
      currency: entry.currency ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      note: entry.note ?? null,
    });
    if (error) throw error;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[audit] FAILED to record ${entry.action} on ${entry.targetTable}/${entry.targetId ?? '-'} ` +
        `by ${actor.label}: ${detail}`,
    );
  }
}

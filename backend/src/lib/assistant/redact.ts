/**
 * Column-name redaction for everything the admin assistant reads.
 *
 * The database role is the first layer (SELECT only, and the OAuth token
 * tables revoked outright — see 0067). This is the second: anything whose
 * *name* says it is a credential is dropped before the model sees it, and
 * PayMongo identifiers are cut to their tail. Name-based on purpose — a column
 * added next year called `foo_secret` is hidden on day one, without anyone
 * remembering to update a list.
 *
 * Customer names, emails and order history are deliberately NOT redacted: the
 * tool exists to answer "what happened to this buyer's order".
 */

/** Dropped entirely. */
const HIDDEN = /(token|secret|password|passwd|_enc$|^enc_|signature_?(image|data|svg)|api_?key|private_?key|ip_hash|signer_ip|signer_user_agent|_hash$)/i;

/** Kept, but only the last 6 characters — enough to match against a PayMongo dashboard. */
const MASKED = /^(paymongo_.*|.*payment_intent.*|.*checkout_session.*|.*_payment_id)$/i;

export function maskTail(v: string): string {
  return v.length <= 6 ? '…' : `…${v.slice(-6)}`;
}

export function redactValue(key: string, value: unknown): unknown {
  if (HIDDEN.test(key)) return '[hidden]';
  if (MASKED.test(key) && typeof value === 'string') return maskTail(value);
  if (value && typeof value === 'object') return redactDeep(value);
  return value;
}

/** Walks objects and arrays (jsonb columns can carry nested credentials too). */
export function redactDeep<T>(input: T): T {
  if (Array.isArray(input)) return input.map((v) => redactDeep(v)) as T;
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = redactValue(k, v);
  return out as T;
}

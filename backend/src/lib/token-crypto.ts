/**
 * Encryption for third-party OAuth tokens.
 *
 * These are the only credentials in this system that belong to *someone else*.
 * A leaked Supabase key or PayMongo secret is Hilom's problem to rotate; a
 * leaked Zoom refresh token is a standing ability to act inside a real
 * facilitator's account, and they would have no idea. So the tokens get a layer
 * of their own on top of RLS and Supabase's at-rest encryption.
 *
 * ## Direct KMS, not envelope encryption
 *
 * The usual advice is to generate a data key, encrypt locally, and store the
 * wrapped key — because KMS refuses payloads over 4 KB and a round trip per
 * item is slow. Neither applies here. OAuth tokens are hundreds of bytes, and
 * these calls happen on connect and on refresh, not on every request. Direct
 * `Encrypt`/`Decrypt` is one moving part instead of three, and the size limit
 * is asserted below rather than assumed.
 *
 * ## Encryption context is the important part
 *
 * Every ciphertext is bound to `{facilitator_id, provider}` as additional
 * authenticated data. KMS refuses to decrypt if the context does not match,
 * which means a ciphertext copied from one row into another is inert. Without
 * it, anyone who could write to the table could move Maria's Zoom token onto
 * their own facilitator row and use it. That is a plausible attack given the
 * table is reachable by every Lambda holding the Supabase secret key; the
 * context makes it fail closed.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

const kms = new KMSClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });

/** The CMK, wired by the marketplace stack. */
const KEY_ID = process.env.INTEGRATION_TOKEN_KEY_ID ?? '';

/** KMS's own hard limit for direct encryption. */
const MAX_PLAINTEXT_BYTES = 4096;

export interface TokenContext {
  facilitatorId: string;
  provider: string;
}

/**
 * The additional authenticated data for a token.
 *
 * Values must be identical on encrypt and decrypt, so this is derived in one
 * place rather than assembled at each call site.
 */
function encryptionContext(ctx: TokenContext): Record<string, string> {
  return { facilitator_id: ctx.facilitatorId, provider: ctx.provider };
}

export class TokenCryptoError extends Error {}

export async function encryptToken(plaintext: string, ctx: TokenContext): Promise<Buffer> {
  if (!KEY_ID) throw new TokenCryptoError('INTEGRATION_TOKEN_KEY_ID is not configured');

  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.byteLength === 0) throw new TokenCryptoError('Refusing to encrypt an empty token');
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    // Asserted rather than silently switching to envelope encryption: a token
    // this large means the provider changed something, and that is worth
    // finding out about deliberately.
    throw new TokenCryptoError(
      `Token is ${bytes.byteLength} bytes, over the ${MAX_PLAINTEXT_BYTES}-byte limit for direct KMS encryption`,
    );
  }

  const res = await kms.send(
    new EncryptCommand({
      KeyId: KEY_ID,
      Plaintext: bytes,
      EncryptionContext: encryptionContext(ctx),
    }),
  );

  if (!res.CiphertextBlob) throw new TokenCryptoError('KMS returned no ciphertext');
  return Buffer.from(res.CiphertextBlob);
}

/**
 * Decrypts a token, or throws.
 *
 * `KeyId` is passed even though KMS can infer it from the ciphertext: without
 * it, a ciphertext produced under a *different* key would still decrypt if this
 * role happened to have access to that key too. Naming the key makes the
 * expectation explicit and the failure loud.
 */
export async function decryptToken(ciphertext: Buffer | Uint8Array, ctx: TokenContext): Promise<string> {
  if (!KEY_ID) throw new TokenCryptoError('INTEGRATION_TOKEN_KEY_ID is not configured');

  const res = await kms.send(
    new DecryptCommand({
      KeyId: KEY_ID,
      CiphertextBlob: Buffer.from(ciphertext),
      EncryptionContext: encryptionContext(ctx),
    }),
  );

  if (!res.Plaintext) throw new TokenCryptoError('KMS returned no plaintext');
  return Buffer.from(res.Plaintext).toString('utf8');
}

/**
 * Postgres `bytea` round-trips through PostgREST as a `\x`-prefixed hex string,
 * not as bytes — so the two helpers below are what make the column usable.
 * Getting this wrong stores the *string* "\x6b6d73..." re-encoded, which
 * decrypts to nothing and is only discovered at refresh time.
 */
export const toBytea = (buf: Buffer): string => `\\x${buf.toString('hex')}`;

export function fromBytea(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') {
    throw new TokenCryptoError(`Expected a bytea hex string, got ${typeof value}`);
  }
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

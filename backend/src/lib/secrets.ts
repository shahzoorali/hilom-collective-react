/**
 * Secrets Manager access, cached for the life of the execution environment.
 *
 * Lambda reuses a warm container across invocations, so fetching on every request
 * would add latency and API calls for a value that effectively never changes.
 * The cache is deliberately per-container: a rotated secret is picked up when
 * containers cycle, and `clearSecretCache` exists for tests.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });

const cache = new Map<string, unknown>();

export interface SupabaseSecret {
  projectRef: string;
  url: string;
  publishableKey: string;
  secretKey: string;
  dbUrl: string;
}

export interface MoodleSecret {
  url: string;
  token: string;
}

export interface PayMongoSecret {
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
}

export async function getSecret<T>(secretId: string): Promise<T> {
  const cached = cache.get(secretId);
  if (cached) return cached as T;

  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString`);
  }
  const parsed = JSON.parse(res.SecretString) as T;
  cache.set(secretId, parsed);
  return parsed;
}

export const getSupabaseSecret = () => getSecret<SupabaseSecret>('hilom/supabase');
export const getMoodleSecret = () => getSecret<MoodleSecret>('hilom/moodle');

/**
 * PayMongo keys are split by mode so that test and live credentials can never be
 * confused for one another. Phase 9 flips this to `hilom/paymongo/live`.
 */
export const getPayMongoSecret = () =>
  getSecret<PayMongoSecret>(process.env.PAYMONGO_SECRET_ID ?? 'hilom/paymongo/test');

export function clearSecretCache(): void {
  cache.clear();
}

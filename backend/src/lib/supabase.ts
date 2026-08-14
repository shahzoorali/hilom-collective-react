/**
 * Supabase client for Lambda.
 *
 * Always constructed with the SECRET key, which bypasses RLS. This client must
 * never be handed to the frontend — the publishable key exists for that. Every
 * order read and write goes through here, because `orders` is unreadable to the
 * anon role by design.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseSecret } from './secrets.js';

let client: SupabaseClient | undefined;

export async function getSupabase(): Promise<SupabaseClient> {
  if (client) return client;

  const { url, secretKey } = await getSupabaseSecret();
  client = createClient(url, secretKey, {
    auth: {
      // No user session in Lambda — the identity is the service role itself.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_centavos: number;
  currency: string;
  thumbnail_url: string | null;
  is_active: boolean;
}

export interface Course {
  moodle_course_id: number;
  fullname: string;
  shortname: string;
  summary: string | null;
  visible: boolean;
  last_synced_at: string;
}

/**
 * Google reCAPTCHA v3 server-side verification.
 *
 * v3 is score-based and invisible — there is no challenge for a human to
 * solve. The frontend widget only produces a token; that token proves
 * nothing by itself. This call to Google's siteverify endpoint, using the
 * secret key, is the actual check — skipping it (trusting a token just
 * because one was present) would make the whole thing decorative.
 */
import { getRecaptchaSecret } from './secrets.js';

/**
 * Below Google's documented default. Lower catches more real submissions;
 * raise if spam gets through, lower if genuine users start getting rejected.
 */
const MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE ?? '0.5');

interface SiteVerifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  'error-codes'?: string[];
}

/**
 * Returns true only if Google confirms the token is genuine, scored above
 * the threshold, AND was generated for the expected action — v3 tokens are
 * per-action, so a token minted for one form must not authorize a different
 * one.
 */
export async function verifyRecaptcha(token: unknown, expectedAction: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;

  try {
    const { secretKey } = await getRecaptchaSecret();
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token }),
    });

    if (!res.ok) return false;
    const json = (await res.json()) as SiteVerifyResponse;

    if (!json.success) {
      console.warn('[recaptcha] rejected:', json['error-codes']);
      return false;
    }
    if (json.action !== expectedAction) {
      console.warn('[recaptcha] action mismatch:', json.action, 'expected', expectedAction);
      return false;
    }
    return (json.score ?? 0) >= MIN_SCORE;
  } catch (err) {
    // A Google outage must not silently disable the check by treating every
    // submission as verified — it fails closed, same as a low score would.
    console.error('[recaptcha] verification call failed', err);
    return false;
  }
}

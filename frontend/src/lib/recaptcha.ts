/**
 * Google reCAPTCHA v3 loader — one shared script tag/instance for the whole
 * app, since every form on the site (community signup, admin-built forms)
 * needs a token and there is no reason to load Google's script more than
 * once per page.
 *
 * v3 is invisible: no puzzle, just a per-submission token that the backend
 * verifies with the secret key (backend/src/lib/recaptcha.ts). Google's
 * floating badge appears automatically once the script loads — their terms
 * require it to stay visible (or the "protected by reCAPTCHA" text shown
 * near each form to substitute for it), so it is left alone rather than
 * hidden with CSS.
 */
import { RECAPTCHA_SITE_KEY } from '../config';

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.grecaptcha) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load reCAPTCHA'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Resolves to a fresh token for the given action. Each call gets its own
 * token — v3 tokens are meant to be minted per-submission, not reused.
 */
export async function getRecaptchaToken(action: string): Promise<string> {
  await loadScript();
  return new Promise((resolve, reject) => {
    window.grecaptcha!.ready(() => {
      window
        .grecaptcha!.execute(RECAPTCHA_SITE_KEY, { action })
        .then(resolve)
        .catch(() => reject(new Error('Captcha check failed — please try again.')));
    });
  });
}

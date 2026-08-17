/**
 * Triggers an Amplify rebuild after a content change that a *live* visitor
 * would already see correctly, but that the prerendered static output would
 * not reflect until the next build.
 *
 * Two different things depend on this and neither is "the page is broken":
 *  - Blog posts (`/blog/<slug>`) are deliberately excluded from Amplify's SPA
 *    fallback rewrite (it assumes every blog URL has its own prerendered
 *    file), so a post's page is genuinely unreachable — a real 404 — until a
 *    build runs the prerender script and writes that file.
 *  - CMS pages (`/<slug>`) are NOT excluded from the fallback, so CmsPage.tsx
 *    fetches and renders them live regardless of whether a build has run.
 *    The gap there is narrower: the prerendered <head> (title, description,
 *    og:image, JSON-LD) that crawlers and social-link unfurlers see without
 *    executing JS goes stale until the next build.
 *
 * Both cases resolve the same way — kick a rebuild — so both call this rather
 * than each carrying their own copy of the webhook logic.
 */
import { getSecret } from './secrets.js';

export async function triggerAmplifyBuild(context: string): Promise<void> {
  const secretId = process.env.BUILD_HOOK_SECRET_ID;
  if (!secretId) {
    console.warn(`[triggerAmplifyBuild:${context}] BUILD_HOOK_SECRET_ID not set, skipping`);
    return;
  }

  const { url } = await getSecret<{ url: string }>(secretId);
  if (!url) {
    console.warn(`[triggerAmplifyBuild:${context}] No webhook URL in secret, skipping`);
    return;
  }

  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    console.warn(`[triggerAmplifyBuild:${context}] webhook returned ${res.status}`);
  }
}

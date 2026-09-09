/**
 * Inline the entry stylesheet into dist/index.html so it no longer blocks the
 * first paint.
 *
 * Vite emits one render-blocking `<link rel="stylesheet">` for the global
 * sheet imported in main.tsx. On a slow connection that link sits on the
 * critical path — the browser will not paint until it resolves — which is what
 * PageSpeed's "render-blocking requests" flags.
 *
 * The sheet is small once compressed (~12 KB brotli) and every route uses
 * effectively all of it (Lighthouse measured ~11 KiB unused), so the simplest
 * fix with no drift risk is to inline the whole compiled file and drop the
 * external request. It is the build's own output, regenerated every time, so
 * there is nothing to keep in sync by hand.
 *
 * Route-split stylesheets (e.g. `Admin-*.css`, loaded only under /admin) are
 * left alone: they are not on the initial paint path.
 *
 * Runs as the last step of `npm run build`, before `npm run prerender` copies
 * dist/index.html per route — so every prerendered page inherits the inlined
 * CSS too.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');

/** Matches the entry stylesheet link Vite injects into index.html. */
const ENTRY_CSS_LINK =
  /<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](\/assets\/index-[^"']+\.css)["'][^>]*>/i;

async function main(): Promise<void> {
  const indexPath = path.join(DIST_DIR, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');

  const match = html.match(ENTRY_CSS_LINK);
  if (!match) {
    // Not fatal: a Vite version or config change could rename the entry chunk.
    // Better to ship a working (if render-blocking) page than to fail the build.
    console.warn(
      '[inline-critical] No entry stylesheet <link> found in dist/index.html — nothing inlined.',
    );
    return;
  }

  const href = match[1];
  const cssPath = path.join(DIST_DIR, href.replace(/^\//, ''));
  const css = await fs.readFile(cssPath, 'utf8');

  html = html.replace(match[0], `<style>${css}</style>`);
  await fs.writeFile(indexPath, html, 'utf8');

  // Drop the now-unreferenced file so it is not shipped as a dead artifact.
  await fs.rm(cssPath, { force: true });
  await fs.rm(`${cssPath}.map`, { force: true });

  console.log(
    `[inline-critical] Inlined ${href} (${(css.length / 1024).toFixed(1)} KiB) into dist/index.html.`,
  );
}

main().catch((err) => {
  console.error('[inline-critical] Fatal error:', err);
  process.exit(1);
});

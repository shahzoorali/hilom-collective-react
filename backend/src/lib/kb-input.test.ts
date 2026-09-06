import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateArticle,
  validateArticlePatch,
  validateCategory,
  KbInputError,
} from './kb-input.js';

const CATEGORY_ID = '11111111-2222-3333-4444-555555555555';

const article = (over: Record<string, unknown> = {}) =>
  validateArticle({ title: 'Rescheduling', category_id: CATEGORY_ID, ...over });

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

test('derives a slug from the title when none is given', () => {
  assert.equal(article().slug, 'rescheduling');
  assert.equal(article({ title: 'How do I cancel?' }).slug, 'how-do-i-cancel');
});

test('rejects an article with no title or no category', () => {
  assert.throws(() => validateArticle({ category_id: CATEGORY_ID }), KbInputError);
  assert.throws(() => validateArticle({ title: '   ', category_id: CATEGORY_ID }), KbInputError);
  assert.throws(() => validateArticle({ title: 'x' }), KbInputError);
  assert.throws(() => validateArticle({ title: 'x', category_id: '  ' }), KbInputError);
});

test('the body is left exactly as written', () => {
  // The whole reason kb-input does not run the body through stripTags: markdown
  // is not markup to be cleaned, and mangling it would corrupt the article.
  const md = '# Heading\n\n- a < b\n- 5 > 3\n\n`<code/>`\n';
  assert.equal(article({ body: md }).body, md);
});

test('every field other than the body is stripped of tags', () => {
  const out = article({
    title: 'Hi <script>alert(1)</script>',
    summary: '<b>bold</b> summary',
    seo_title: '<i>seo</i>',
  });
  assert.ok(!out.title.includes('<'), `title kept markup: ${out.title}`);
  assert.ok(!out.summary?.includes('<'), `summary kept markup: ${out.summary}`);
  assert.ok(!out.seo_title?.includes('<'), `seo_title kept markup: ${out.seo_title}`);
});

test('rejects a body past the size cap', () => {
  assert.throws(() => article({ body: 'x'.repeat(200_001) }), KbInputError);
  assert.doesNotThrow(() => article({ body: 'x'.repeat(200_000) }));
});

test('kind and audience accept only known values, defaulting when absent', () => {
  assert.equal(article().kind, 'guide');
  assert.equal(article().audience, 'client');
  assert.equal(article({ kind: 'troubleshooting' }).kind, 'troubleshooting');
  assert.equal(article({ audience: 'both' }).audience, 'both');
  assert.throws(() => article({ kind: 'faq' }), KbInputError);
  assert.throws(() => article({ audience: 'admin' }), KbInputError);
});

test('tags are lowercased, de-duplicated, and capped', () => {
  assert.deepEqual(article({ tags: ['Booking', 'booking', ' BOOKING '] }).tags, ['booking']);
  assert.equal(article({ tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }).tags.length, 20);
  assert.deepEqual(article({ tags: 'not-an-array' }).tags, []);
  assert.deepEqual(article({ tags: [1, null, 'ok'] }).tags, ['ok']);
});

test('position is clamped rather than rejected', () => {
  assert.equal(article({ position: -5 }).position, 0);
  assert.equal(article({ position: 3.7 }).position, 3);
  assert.equal(article({ position: 1e9 }).position, 100_000);
  assert.throws(() => article({ position: 'abc' }), KbInputError);
});

test('empty optional text becomes null, not an empty string', () => {
  // Postgres treats '' and null differently on read; the frontend checks for
  // null. One of the two has to be canonical.
  assert.equal(article({ summary: '' }).summary, null);
  assert.equal(article({ summary: '   ' }).summary, null);
  assert.equal(article({ seo_description: '<b></b>' }).seo_description, null);
});

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

test('a patch touches only the fields it names', () => {
  const patch = validateArticlePatch({ summary: 'new summary' });
  assert.deepEqual(Object.keys(patch), ['summary']);
});

test('a patch does not silently reset kind or audience to defaults', () => {
  // The bug this guards: running the full validator over a partial body would
  // return kind:'guide' / audience:'client' for a request that never mentioned
  // them, quietly reclassifying a facilitator troubleshooting article.
  const patch = validateArticlePatch({ title: 'Renamed' });
  assert.equal('kind' in patch, false);
  assert.equal('audience' in patch, false);
});

test('a patch rejects an empty title but allows an empty body', () => {
  assert.throws(() => validateArticlePatch({ title: '  ' }), KbInputError);
  // Clearing a body is legitimate — it just cannot then be published.
  assert.equal(validateArticlePatch({ body: '' }).body, '');
});

test('an empty patch is empty, so the handler can reject it', () => {
  assert.deepEqual(validateArticlePatch({}), {});
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

test('a category derives its slug and requires a name', () => {
  assert.equal(validateCategory({ name: 'Sessions & Booking' }).slug, 'sessions-booking');
  assert.throws(() => validateCategory({}), KbInputError);
});

test('a section cannot be named "search", which /help/search already owns', () => {
  // Without this the section would save, appear in the admin, and be
  // permanently unreachable — the route above it always wins.
  assert.throws(() => validateCategory({ name: 'Search' }), KbInputError);
  assert.throws(() => validateCategory({ name: 'Anything', slug: 'search' }), KbInputError);
  // Adjacent names are still fine.
  assert.equal(validateCategory({ name: 'Searching for help' }).slug, 'searching-for-help');
});

test('an icon must be a plain key', () => {
  assert.equal(validateCategory({ name: 'A', icon: 'life-buoy' }).icon, 'life-buoy');
  assert.equal(validateCategory({ name: 'A' }).icon, null);
  assert.throws(() => validateCategory({ name: 'A', icon: '../../etc' }), KbInputError);
  assert.throws(() => validateCategory({ name: 'A', icon: 'Bad Icon' }), KbInputError);
});

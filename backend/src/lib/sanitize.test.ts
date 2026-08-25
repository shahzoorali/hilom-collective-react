/**
 * Tests for stripTags's plain-text guarantee.
 *
 * The one rule this pins down: every caller of stripTags renders the result
 * as a React text node, never through dangerouslySetInnerHTML, so the output
 * must be actual plain text — not HTML with the special characters encoded.
 * Left encoded, "Coaching & Wellness" would display on screen as the literal
 * characters "Coaching &amp; Wellness", which is the bug this guards against.
 *
 * Run with `npm run test` in backend/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripTags, sanitizeRichText } from './sanitize.js';

describe('stripTags — plain text, not HTML-with-entities', () => {
  it('leaves an ampersand as an ampersand', () => {
    assert.equal(stripTags('Coaching & Wellness'), 'Coaching & Wellness');
  });

  it('leaves angle brackets that are not markup as themselves', () => {
    assert.equal(stripTags('5 < 10 > 3'), '5 < 10 > 3');
  });

  it('still strips real tags', () => {
    assert.equal(stripTags('<b>bold</b> text'), 'bold text');
    assert.equal(stripTags('<script>alert(1)</script>safe'), 'safe');
  });

  it('treats a typed entity and its literal character the same way', () => {
    // sanitize-html's parser normalizes &lt; to the character < on the way in
    // — the two inputs are indistinguishable by the time output is produced,
    // and both mean the same character in plain text, so both decode to it.
    assert.equal(stripTags('&lt;'), '<');
    assert.equal(stripTags('<'), '<');
  });

  it('round-trips a title with both an ampersand and real markup to strip', () => {
    assert.equal(
      stripTags('<em>Life</em> coach & strategist'),
      'Life coach & strategist',
    );
  });
});

describe('sanitizeRichText — unaffected by the stripTags fix', () => {
  it('still HTML-encodes an ampersand inside allowed rich text', () => {
    // This function's output IS injected via dangerouslySetInnerHTML, so it
    // must stay valid HTML — the opposite contract from stripTags.
    assert.equal(sanitizeRichText('<p>Coaching & Wellness</p>'), '<p>Coaching &amp; Wellness</p>');
  });
});

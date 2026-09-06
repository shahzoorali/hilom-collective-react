import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderHighlight, stripMarkdown, slugifyHeading } from './markdown.js';

const html = (src: string) => renderMarkdown(src).html;

// ---------------------------------------------------------------------------
// Security. This output goes to dangerouslySetInnerHTML, so these are the
// tests that matter most.
// ---------------------------------------------------------------------------

test('inline HTML in the source is rendered as text, never as markup', () => {
  const out = html('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('an img onerror payload cannot produce an element', () => {
  const out = html('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&lt;img'), out);
});

test('javascript: and data: links are refused', () => {
  for (const bad of [
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](vbscript:msgbox)',
  ]) {
    const out = html(bad);
    assert.ok(!/<a\s/.test(out), `${bad} produced a link: ${out}`);
    assert.ok(!out.toLowerCase().includes('href='), `${bad} produced an href: ${out}`);
  }
});

test('http, mailto, relative and anchor links are allowed', () => {
  assert.match(html('[x](https://example.com)'), /<a href="https:\/\/example\.com"/);
  assert.match(html('[x](mailto:a@b.com)'), /<a href="mailto:a@b\.com"/);
  assert.match(html('[x](/account/bookings)'), /<a href="\/account\/bookings"/);
  assert.match(html('[x](#step-2)'), /<a href="#step-2"/);
});

test('external links open in a new tab, internal ones do not', () => {
  assert.match(html('[x](https://example.com)'), /target="_blank" rel="noreferrer noopener"/);
  assert.ok(!html('[x](/help)').includes('target="_blank"'));
});

test('a quote in a link target cannot break out of the attribute', () => {
  const out = html('[x](https://example.com/"onmouseover="alert(1))');
  assert.ok(!out.includes('onmouseover="alert'), out);
});

test('a link with a query string does not accumulate entities', () => {
  // The bug this guards: the href arrives escaped, so &amp; must be decoded
  // before being re-escaped, or every render doubles it.
  const once = html('[x](https://example.com/?a=1&b=2)');
  assert.match(once, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.ok(!once.includes('&amp;amp;'), once);
});

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

test('headings render and collect a TOC of h2 and h3 only', () => {
  const { html: out, toc } = renderMarkdown('## First\n\ntext\n\n### Nested\n\n#### Deep');
  assert.match(out, /<h2 id="first">First<\/h2>/);
  assert.match(out, /<h3 id="nested">Nested<\/h3>/);
  assert.match(out, /<h4 id="deep">Deep<\/h4>/);
  assert.deepEqual(
    toc.map((t) => [t.level, t.id]),
    [[2, 'first'], [3, 'nested']],
  );
});

test('a single # is demoted, since the page renders the title itself', () => {
  const { html: out } = renderMarkdown('# Article title');
  assert.ok(!out.includes('<h1'), out);
  assert.match(out, /<h2 id="article-title">/);
});

test('duplicate headings get distinct ids so the TOC still links', () => {
  const { toc } = renderMarkdown('## Before you start\n\na\n\n## Before you start');
  assert.deepEqual(toc.map((t) => t.id), ['before-you-start', 'before-you-start-2']);
});

test('bullets and numbered steps render as lists', () => {
  assert.equal(html('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(html('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('switching list type starts a new list rather than merging', () => {
  const out = html('- a\n1. b');
  assert.equal(out, '<ul><li>a</li></ul>\n<ol><li>b</li></ol>');
});

test('a blockquote becomes the callout element', () => {
  assert.match(html('> Careful here.'), /<blockquote class="kb-callout">Careful here\.<\/blockquote>/);
});

test('paragraphs join wrapped lines and split on blank lines', () => {
  assert.equal(html('one\ntwo\n\nthree'), '<p>one two</p>\n<p>three</p>');
});

test('fenced code is literal, including markdown inside it', () => {
  const out = html('```\n## not a heading\n**not bold**\n```');
  assert.match(out, /<pre><code>## not a heading\n\*\*not bold\*\*<\/code><\/pre>/);
});

test('an unterminated fence still renders instead of swallowing the article', () => {
  assert.match(html('```\nleft open'), /<pre><code>left open<\/code><\/pre>/);
});

test('a horizontal rule renders', () => {
  assert.match(html('---'), /<hr \/>/);
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test('bold and italic render', () => {
  assert.match(html('**bold**'), /<strong>bold<\/strong>/);
  assert.match(html('*italic*'), /<em>italic<\/em>/);
});

test('code spans are not also treated as emphasis', () => {
  // An article explaining markdown formatting is exactly the case that breaks
  // a naive renderer.
  const out = html('Use `**stars**` for bold.');
  assert.match(out, /<code>\*\*stars\*\*<\/code>/);
  assert.ok(!out.includes('<strong>'), out);
});

test('a code span containing html is escaped', () => {
  assert.match(html('`<b>`'), /<code>&lt;b&gt;<\/code>/);
});

// ---------------------------------------------------------------------------
// Search highlight
// ---------------------------------------------------------------------------

test('highlight sentinels become mark, and nothing else becomes markup', () => {
  assert.equal(
    renderHighlight('your [[hl]]session[[/hl]] is confirmed'),
    'your <mark>session</mark> is confirmed',
  );
});

test('a snippet containing html is escaped before the sentinels are swapped', () => {
  const out = renderHighlight('<script>alert(1)</script> [[hl]]hit[[/hl]]');
  assert.ok(!out.includes('<script>'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
  assert.ok(out.includes('<mark>hit</mark>'), out);
});

test('a literal [[hl]] typed by an author cannot inject a stray mark', () => {
  // Only the database produces these; an author typing one gets a <mark> too,
  // which is harmless — the point is that it cannot become anything else.
  const out = renderHighlight('[[hl]]<img src=x>[[/hl]]');
  assert.ok(!out.includes('<img'), out);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('stripMarkdown produces plain text for a meta description', () => {
  assert.equal(
    stripMarkdown('## Heading\n\nSome **bold** text with a [link](https://x.com).'),
    'Heading Some bold text with a link.',
  );
});

test('stripMarkdown truncates with an ellipsis', () => {
  const out = stripMarkdown('word '.repeat(100), 20);
  assert.ok(out.length <= 20, out);
  assert.ok(out.endsWith('…'), out);
});

test('slugifyHeading makes an anchor-safe id', () => {
  assert.equal(slugifyHeading('Before you start!'), 'before-you-start');
  assert.equal(slugifyHeading('  Spaces  &  symbols  '), 'spaces-symbols');
});

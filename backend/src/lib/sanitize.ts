/**
 * HTML sanitization for CMS rich-text content.
 *
 * Sanitizing on SAVE rather than on render is deliberate: what lands in the
 * database is already safe, so the renderer's dangerouslySetInnerHTML is a read
 * of trusted data, and a leaked admin key cannot plant a script tag that a
 * future render path forgets to clean.
 */
import sanitizeHtml from 'sanitize-html';

const OPTIONS: sanitizeHtml.IOptions = {
  // Deliberately narrow. Layout comes from block types, not from pasted markup,
  // so the editor never needs div/span/style/class.
  allowedTags: ['p', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a', 'br', 'blockquote'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  // No `data:` — an image/svg+xml data URI is a script execution vector.
  allowedSchemes: ['http', 'https', 'mailto'],
  // Anything opening a new tab must not be able to reach back via window.opener.
  transformTags: {
    a: (tagName, attribs) =>
      attribs.target === '_blank'
        ? { tagName, attribs: { ...attribs, rel: 'noreferrer noopener' } }
        : { tagName, attribs },
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/** Plain-text fields (headings, captions) must never carry markup at all. */
export function stripTags(text: string): string {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

/**
 * The Hilom email shell — one branded frame every transactional email renders
 * inside.
 *
 * Before this, each sender hand-wrote its own `<p>` tags. That is why the
 * welcome email, the enrolment email and the booking emails all looked like
 * three different companies: nothing was shared, so nothing matched. Every
 * template now composes from the helpers here, which is what keeps them
 * consistent by construction rather than by everyone remembering.
 *
 * ## Why this is written the way it is
 *
 * Email HTML is not web HTML, and most of what looks archaic below is load
 * bearing:
 *
 *  * **Tables for layout.** Outlook renders through Word, which has no flexbox
 *    or grid and ignores `max-width` on divs. A centred 600px table is the one
 *    construction that survives every client.
 *  * **Inline styles.** Gmail strips `<style>` blocks when a message is
 *    clipped or forwarded, and several clients drop them entirely. Anything
 *    that matters is inlined on the element.
 *  * **No webfonts.** Libre Baskerville and Montserrat are the brand faces,
 *    but Outlook and Gmail will not load either. The stacks below name them
 *    first and fall back to Georgia and Helvetica — near enough in shape that
 *    the brand still reads, honest about the fact that most recipients see the
 *    fallback.
 *  * **Explicit background colours everywhere.** Clients with a dark mode
 *    invert unpainted surfaces, which is how dark text ends up on a dark
 *    ground. Every cell paints its own.
 *  * **A `preheader`.** The inbox preview text is otherwise scraped from
 *    whatever markup comes first, which for a logo-first layout is nothing
 *    useful. It is hidden in the body and shown only in the list view.
 */

/** Brand palette, mirroring `:root` in frontend/src/index.css. */
const BRAND = {
  forest: '#2f5e3e',
  forestDark: '#244a31',
  ochre: '#f2a429',
  onOchre: '#2b1f04',
  cream: '#f3e6c8',
  ink: '#2b332c',
  muted: '#6b7568',
  surface: '#ffffff',
  page: '#fffdf8',
  line: '#e7e0cc',
} as const;

const SERIF = "'Libre Baskerville', Georgia, 'Times New Roman', serif";
const SANS = "'Montserrat', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const SITE_URL = 'https://www.hilomcollective.com';

/**
 * Served from the CMS media CloudFront distribution under a fixed key, so the
 * URL is stable across frontend builds — the bundled copy in
 * frontend/src/assets is content-hashed and would break on every deploy.
 */
const LOGO_URL = 'https://d3krjxfbid1bdd.cloudfront.net/brand/hilom-logo.png';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A body paragraph. */
export function p(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${BRAND.ink};">${html}</p>`;
}

/** Smaller, quieter text — closing notes, caveats, "if you need help". */
export function note(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${BRAND.muted};">${html}</p>`;
}

/**
 * The labelled facts of the email — when, who, how much.
 *
 * A bordered block rather than loose paragraphs because this is what someone
 * scrolls back to find later, and it should be findable at a glance rather
 * than read.
 */
export function details(rows: { label: string; value: string }[]): string {
  const cells = rows
    .map(
      ({ label, value }) => `
      <tr>
        <td style="padding:4px 12px 4px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${BRAND.ink};font-weight:600;vertical-align:top;">${value}</td>
      </tr>`,
    )
    .join('');

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;background-color:${BRAND.page};border:1px solid ${BRAND.line};border-radius:8px;">
    <tr><td style="padding:16px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table>
    </td></tr>
  </table>`;
}

/**
 * A "bulletproof" button: a table cell with a background and a padded anchor.
 *
 * Not a styled `<a>`, because Outlook drops padding on inline elements and the
 * button collapses to bare underlined text — on the one element in the email
 * that exists to be clicked.
 */
export function button(label: string, href: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    <tr><td align="center" bgcolor="${BRAND.ochre}" style="border-radius:8px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:15px;font-weight:700;color:${BRAND.onOchre};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** A plain link in brand colour, for use inside `p()` / `note()`. */
export function link(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${BRAND.forest};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

export interface EmailLayoutInput {
  /** Inbox preview line. Falls back to the heading when omitted. */
  preheader?: string;
  heading: string;
  /** Composed from the helpers above. */
  body: string;
}

/** Wraps a composed body in the branded frame. */
export function renderEmail({ preheader, heading, body }: EmailLayoutInput): string {
  const preview = escapeHtml(preheader ?? heading);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preview}</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.cream};">
    <tr><td align="center" style="padding:28px 12px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background-color:${BRAND.surface};border-radius:12px;overflow:hidden;">

        <!-- Masthead. Cream behind the mark rather than forest: the logo is
             dark, and this way it reads whether or not images load. -->
        <tr><td align="center" bgcolor="${BRAND.page}" style="padding:26px 24px 22px;border-bottom:3px solid ${BRAND.forest};">
          <a href="${SITE_URL}" style="text-decoration:none;">
            <img src="${LOGO_URL}" alt="Hilom Collective" width="150"
                 style="display:block;width:150px;max-width:150px;height:auto;border:0;">
          </a>
        </td></tr>

        <tr><td style="padding:32px 32px 8px;">
          <h1 style="margin:0 0 18px;font-family:${SERIF};font-size:23px;line-height:1.35;font-weight:700;color:${BRAND.forestDark};">${escapeHtml(heading)}</h1>
          ${body}
        </td></tr>

        <tr><td bgcolor="${BRAND.page}" style="padding:22px 32px;border-top:1px solid ${BRAND.line};">
          <p style="margin:0 0 6px;font-family:${SERIF};font-size:14px;color:${BRAND.forest};">Hilom Collective</p>
          <p style="margin:0 0 10px;font-family:${SANS};font-size:12px;line-height:1.6;color:${BRAND.muted};">
            Learn. Reflect. Grow.
          </p>
          <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${BRAND.muted};">
            <a href="${SITE_URL}" style="color:${BRAND.forest};text-decoration:none;">hilomcollective.com</a>
            &nbsp;·&nbsp;
            <a href="mailto:kumusta@hilomcollective.com" style="color:${BRAND.forest};text-decoration:none;">kumusta@hilomcollective.com</a>
          </p>
        </td></tr>

      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * The plain-text counterpart, kept here so the signature matches the HTML
 * footer without every sender repeating it.
 *
 * Text parts are not a formality: they are what plain-text clients, some
 * accessibility tooling and most spam filters actually read, and a message
 * with a rich HTML part and an empty text part scores badly.
 */
export function renderText(heading: string, lines: string[]): string {
  return [
    heading,
    '',
    ...lines,
    '',
    '—',
    'Hilom Collective · Learn. Reflect. Grow.',
    SITE_URL,
    'kumusta@hilomcollective.com',
  ].join('\n');
}

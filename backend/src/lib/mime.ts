/**
 * A minimal MIME composer for the one email that needs an attachment.
 *
 * SESv2's `Content.Simple` cannot carry attachments, and the only attachment
 * this codebase ever sends is the participant-agreement PDF on a retreat
 * confirmation. Rather than take on nodemailer for that, this builds exactly
 * the tree that one email needs:
 *
 *   multipart/mixed
 *   ├── multipart/alternative
 *   │   ├── text/plain
 *   │   └── text/html
 *   └── application/pdf  (attachment)
 *
 * Every part is base64-encoded, bodies included. That sidesteps the
 * line-length and bare CR/LF rules in RFC 5322 for the price of ~33% size on
 * parts that are mostly ASCII — noise next to a ~2 MB PDF in the same message.
 *
 * Header values are ASCII in practice (sender name, a receipt number, an event
 * title). `encodeHeaderWord` covers a non-ASCII title with a single RFC 2047
 * encoded-word; it does not fold very long ones, which no real subject here
 * reaches.
 */

const CRLF = '\r\n';

/** base64, wrapped to 76-char lines per RFC 2045. */
function b64(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
  return buf.toString('base64').replace(/.{76}/g, `$&${CRLF}`);
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/** RFC 2047 encoded-word, only when the value actually needs it. */
function encodeHeaderWord(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function boundary(tag: string): string {
  return `----=_Hilom_${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export interface RawEmailAttachment {
  /** Kept ASCII by callers — see the file header. */
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/**
 * A full RFC 5322 message ready for SESv2 `Content.Raw.Data`.
 *
 * `from` is used verbatim as the From header, so it may already be a
 * `Name <addr>` string.
 */
export function buildRawEmail(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: RawEmailAttachment[];
}): Uint8Array {
  const mixB = boundary('mix');
  const altB = boundary('alt');

  const lines: string[] = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: multipart/mixed; boundary="${mixB}"`,
    '',
    `--${mixB}`,
    `Content-Type: multipart/alternative; boundary="${altB}"`,
    '',
    `--${altB}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(input.text),
    '',
    `--${altB}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(input.html),
    '',
    `--${altB}--`,
    '',
  ];

  for (const a of input.attachments) {
    lines.push(
      `--${mixB}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      b64(a.content),
      '',
    );
  }

  lines.push(`--${mixB}--`, '');

  return new TextEncoder().encode(lines.join(CRLF));
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawEmail } from './mime.js';

/** Pull one part's decoded body out of a raw MIME string by its Content-Type. */
function decodePart(raw: string, contentType: string): string {
  const marker = `Content-Type: ${contentType}`;
  const start = raw.indexOf(marker);
  assert.notEqual(start, -1, `part ${contentType} present`);
  // Body starts after the blank line that ends this part's headers.
  const bodyStart = raw.indexOf('\r\n\r\n', start) + 4;
  const bodyEnd = raw.indexOf('\r\n--', bodyStart);
  const b64 = raw.slice(bodyStart, bodyEnd).replace(/\r\n/g, '');
  return Buffer.from(b64, 'base64').toString('utf-8');
}

describe('buildRawEmail', () => {
  const base = {
    from: 'Hilom Collective <hello@hilomcollective.com>',
    to: 'someone@example.com',
    subject: "You're going to Return to Self",
    text: 'Plain text body — with an em dash.',
    html: '<p>HTML body — with an em dash.</p>',
  };

  it('nests alternative inside mixed and puts the attachment at the top level', () => {
    const raw = Buffer.from(
      buildRawEmail({
        ...base,
        attachments: [
          { filename: 'Agreement.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2, 3, 4]) },
        ],
      }),
    ).toString('utf-8');

    assert.match(raw, /Content-Type: multipart\/mixed; boundary="(.+)"/);
    assert.match(raw, /Content-Type: multipart\/alternative; boundary="(.+)"/);
    assert.match(raw, /Content-Disposition: attachment; filename="Agreement\.pdf"/);
    assert.equal(decodePart(raw, 'text/plain; charset=UTF-8'), base.text);
    assert.equal(decodePart(raw, 'text/html; charset=UTF-8'), base.html);

    // The attachment round-trips byte-for-byte.
    const pdfStart = raw.indexOf('filename="Agreement.pdf"');
    const bodyStart = raw.indexOf('\r\n\r\n', pdfStart) + 4;
    const bodyEnd = raw.indexOf('\r\n--', bodyStart);
    const bytes = Buffer.from(raw.slice(bodyStart, bodyEnd).replace(/\r\n/g, ''), 'base64');
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
  });

  it('leaves an ASCII subject alone and RFC 2047-encodes a non-ASCII one', () => {
    const ascii = Buffer.from(buildRawEmail({ ...base, attachments: [] })).toString('utf-8');
    assert.match(ascii, /Subject: You're going to Return to Self\r\n/);

    const unicode = Buffer.from(
      buildRawEmail({ ...base, subject: 'Café Retreat ☕', attachments: [] }),
    ).toString('utf-8');
    assert.match(unicode, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    const word = unicode.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)![1]!;
    assert.equal(Buffer.from(word, 'base64').toString('utf-8'), 'Café Retreat ☕');
  });

  it('wraps base64 bodies at 76 characters', () => {
    const raw = Buffer.from(
      buildRawEmail({ ...base, text: 'x'.repeat(500), attachments: [] }),
    ).toString('utf-8');
    const plainStart = raw.indexOf('Content-Type: text/plain');
    const bodyStart = raw.indexOf('\r\n\r\n', plainStart) + 4;
    const bodyEnd = raw.indexOf('\r\n--', bodyStart);
    for (const line of raw.slice(bodyStart, bodyEnd).split('\r\n')) {
      assert.ok(line.length <= 76, `line within 76: "${line}" (${line.length})`);
    }
  });
});

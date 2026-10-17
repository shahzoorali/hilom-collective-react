import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { integerToWords, pesosInWords, peso, shortDate, longDate, receiptNumber, wrapText } from './receipt-words.js';
import { renderAcknowledgmentReceipt, RECEIPT_DEFAULTS } from './acknowledgment-receipt.js';

describe('amount in words', () => {
  test('matches the existing receipts', () => {
    assert.equal(pesosInWords(5229004), 'Fifty-Two Thousand Two Hundred Ninety Pesos and 04/100 Only.');
    assert.equal(pesosInWords(3150000), 'Thirty-One Thousand Five Hundred Pesos and 00/100 Only.');
  });
  test('edges', () => {
    assert.equal(integerToWords(0), 'Zero');
    assert.equal(integerToWords(15), 'Fifteen');
    assert.equal(integerToWords(100), 'One Hundred');
    assert.equal(integerToWords(1000001), 'One Million One');
    assert.equal(integerToWords(2365), 'Two Thousand Three Hundred Sixty-Five');
    assert.equal(pesosInWords(100), 'One Peso and 00/100 Only.');
    assert.equal(pesosInWords(98), 'Zero Pesos and 98/100 Only.');
  });
});

describe('formats', () => {
  test('peso, dates, numbers', () => {
    assert.equal(peso(4992408), '₱49,924.08');
    assert.equal(shortDate('2026-09-25'), 'Sep 25, 2026');
    assert.equal(longDate('2026-10-15'), '15 October 2026');
    assert.equal(receiptNumber(2026, 7), 'HC-AR-2026-0007');
  });
  test('wrap', () => {
    assert.deepEqual(wrapText('aa bb cc', 5, (s) => s.length), ['aa bb', 'cc']);
  });
});

describe('render', () => {
  test('produces a one-page PDF from the real assets', async () => {
    const at = (p: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../assets/${p}`, import.meta.url))));
    const pdf = await renderAcknowledgmentReceipt(
      {
        receipt_no: 'HC-AR-2026-0001',
        issue_date: '2026-10-15',
        recipient_heading: 'Premyer Tamayo (Prem)',
        recipient_name: 'Premyer Tamayo',
        recipient_title: 'Instructor',
        subtitle: 'HIIT Pilates Group Class and Teacher Training',
        layout: 'dated',
        lines: [
          { label: 'Sep 25, 2026', amount_centavos: 236596 },
          { label: 'Oct 15, 2026', amount_centavos: 4992408 },
        ],
        signatory: RECEIPT_DEFAULTS.signatory,
        include_signature: true,
        contact: RECEIPT_DEFAULTS.contact,
      },
      {
        regular: at('fonts/Montserrat-Regular.ttf'),
        bold: at('fonts/Montserrat-Bold.ttf'),
        italic: at('fonts/Montserrat-Italic.ttf'),
        logo: at('receipt/logo.png'),
        watermark: at('receipt/watermark.png'),
        signature: at('receipt/signature.png'),
      },
    );
    assert.ok(pdf.length > 20000);
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
    if (process.env.RECEIPT_PREVIEW) (await import('node:fs')).writeFileSync(process.env.RECEIPT_PREVIEW, pdf);
  });
});

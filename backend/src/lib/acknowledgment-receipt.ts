/**
 * The "Payment Acknowledgment Receipt" Hilom gives a facilitator when it pays
 * them — rebuilt from the hand-made Canva template so the admin can issue one
 * in a click.
 *
 * Layout follows the template (A4): logo top-left, centred title, recipient and
 * date, a two-column table (Payment Date | Amount for several payments,
 * Description | Amount for one), the total in words, two signature blocks with
 * the CEO's signature image, the non-BIR disclaimer, a faded leaf watermark and
 * the contact footer. Added over the template: a receipt number under the date,
 * so a signed copy can be matched to its record.
 *
 * Assets are passed in rather than imported so a test (or a local preview
 * script) can render one from files on disk; receipt-assets.ts imports them
 * for the Lambda bundle.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { longDate, peso, pesosInWords, wrapText } from './receipt-words.js';

export interface ReceiptAssets {
  regular: Uint8Array;
  bold: Uint8Array;
  italic: Uint8Array;
  logo: Uint8Array;
  watermark: Uint8Array;
  signature: Uint8Array;
}

export interface ReceiptLine {
  /** A formatted date ("Sep 25, 2026") or a description. */
  label: string;
  amount_centavos: number;
}

export interface ReceiptData {
  receipt_no: string;
  issue_date: string; // YYYY-MM-DD
  /** Header line, e.g. "PREMYER TAMAYO (PREM)". Upper-cased when drawn. */
  recipient_heading: string;
  /** Used in the sentence and under the signature line, e.g. "Premyer Tamayo". */
  recipient_name: string;
  recipient_title: string; // INSTRUCTOR
  subtitle: string; // what the payments were for
  layout: 'dated' | 'described';
  lines: ReceiptLine[];
  signatory: { name: string; title: string; org: string };
  include_signature: boolean;
  contact: { phone: string; email: string };
}

export const RECEIPT_DEFAULTS = {
  signatory: { name: 'Crizy Austria', title: 'Founder and CEO', org: 'Hilom Collective' },
  contact: { phone: '+639176882931', email: 'kumusta@hilomcollective.com' },
  recipient_title: 'Instructor',
  company: 'Hilom Collective Wellness Hub',
} as const;

const W = 595.5;
const H = 842.25;
const LEFT = 60;
const RIGHT = 536;
const INK = rgb(0x1b / 255, 0x1a / 255, 0x1a / 255);
const BLACK = rgb(0, 0, 0);
const MUTED = rgb(0.42, 0.42, 0.42);
const PILL = rgb(0.92, 0.92, 0.92);

/** pdf-lib measures from the bottom; the template is laid out from the top. */
const y = (top: number, size: number) => H - top - size * 0.8;

function text(page: PDFPage, s: string, x: number, top: number, font: PDFFont, size: number, color = INK) {
  page.drawText(s, { x, y: y(top, size), font, size, color });
}

export async function renderAcknowledgmentReceipt(data: ReceiptData, assets: ReceiptAssets): Promise<Uint8Array> {
  if (!data.lines.length) throw new Error('A receipt needs at least one payment');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Payment Acknowledgment Receipt ${data.receipt_no}`);
  doc.setAuthor(RECEIPT_DEFAULTS.company);
  doc.setSubject(`Payment to ${data.recipient_name}`);
  doc.setCreator('Hilom admin');

  const [regular, bold, italic] = await Promise.all([
    doc.embedFont(assets.regular, { subset: true }),
    doc.embedFont(assets.bold, { subset: true }),
    doc.embedFont(assets.italic, { subset: true }),
  ]);
  const [logo, watermark, signature] = await Promise.all([
    doc.embedPng(assets.logo),
    doc.embedPng(assets.watermark),
    doc.embedPng(assets.signature),
  ]);

  const page = doc.addPage([W, H]);

  // Watermark first so everything sits on top of it.
  const wmW = 225;
  const wmH = (wmW * watermark.height) / watermark.width;
  page.drawImage(watermark, { x: W - wmW + 20, y: -wmH * 0.3, width: wmW, height: wmH, opacity: 0.2 });

  const logoW = 172;
  page.drawImage(logo, { x: 43, y: H - 36 - (logoW * logo.height) / logo.width, width: logoW, height: (logoW * logo.height) / logo.width });

  const title = 'PAYMENT ACKNOWLEDGMENT RECEIPT';
  text(page, title, (W - bold.widthOfTextAtSize(title, 15)) / 2, 162, bold, 15, BLACK);

  // Recipient and date
  text(page, `RECIPIENT: ${data.recipient_heading.toUpperCase()}`, 63, 219, bold, 12);
  const date = longDate(data.issue_date);
  text(page, date, RIGHT - regular.widthOfTextAtSize(date, 12), 220, regular, 12);
  const no = `No. ${data.receipt_no}`;
  text(page, no, RIGHT - regular.widthOfTextAtSize(no, 8.5), 237, regular, 8.5, MUTED);
  let top = 237;
  for (const l of wrapText(data.subtitle, 300, (s) => regular.widthOfTextAtSize(s, 10))) {
    text(page, l, 63, top, regular, 10);
    top += 13;
  }

  // Sentence
  top = Math.max(top + 23, 273);
  const sentence = `This document acknowledges the following payments made by ${RECEIPT_DEFAULTS.company} to ${data.recipient_name}.`;
  for (const l of wrapText(sentence, RIGHT - 65, (s) => regular.widthOfTextAtSize(s, 12))) {
    text(page, l, 65, top, regular, 12);
    top += 16;
  }

  // Table
  top += 13;
  const rowH = data.lines.length > 6 ? 26 : 35;
  const mid = data.layout === 'dated' ? 298 : 420;
  const rows = data.lines.length + 2; // header + lines + total
  const tableTop = top;
  const tableH = rowH * rows;
  page.drawRectangle({ x: LEFT, y: H - tableTop - tableH, width: RIGHT - LEFT, height: tableH, borderColor: BLACK, borderWidth: 0.75 });
  for (let r = 1; r < rows; r++) {
    page.drawLine({ start: { x: LEFT, y: H - tableTop - rowH * r }, end: { x: RIGHT, y: H - tableTop - rowH * r }, thickness: 0.75, color: BLACK });
  }
  page.drawLine({ start: { x: mid, y: H - tableTop }, end: { x: mid, y: H - tableTop - tableH }, thickness: 0.75, color: BLACK });

  const cellTop = (r: number) => tableTop + rowH * r + (rowH - 12) / 2;
  const head1 = data.layout === 'dated' ? 'Payment Date' : 'Description';
  text(page, head1, LEFT + (mid - LEFT - bold.widthOfTextAtSize(head1, 12)) / 2, cellTop(0), bold, 12, BLACK);
  text(page, 'Amount', mid + (RIGHT - mid - bold.widthOfTextAtSize('Amount', 12)) / 2, cellTop(0), bold, 12, BLACK);

  data.lines.forEach((line, i) => {
    const r = i + 1;
    let label = line.label;
    const maxLabel = mid - LEFT - 20;
    while (regular.widthOfTextAtSize(label, 12) > maxLabel && label.length > 4) label = `${label.slice(0, -2)}…`;
    if (data.layout === 'dated') {
      const w = regular.widthOfTextAtSize(label, 12);
      page.drawRectangle({ x: LEFT + 6, y: H - cellTop(r) - 14, width: w + 14, height: 17, color: PILL, borderColor: PILL, borderWidth: 0 });
      text(page, label, LEFT + 13, cellTop(r), regular, 12, BLACK);
    } else {
      text(page, label, LEFT + 7, cellTop(r), regular, 12, BLACK);
    }
    text(page, peso(line.amount_centavos), mid + 6, cellTop(r), regular, 12, BLACK);
  });

  const total = data.lines.reduce((s, l) => s + l.amount_centavos, 0);
  const totalLabel = data.layout === 'dated' ? 'Total Received' : 'Total Payment';
  text(page, totalLabel, LEFT + 6, cellTop(rows - 1), bold, 12, BLACK);
  text(page, peso(total), mid + 6, cellTop(rows - 1), bold, 12, BLACK);

  // Total in words, confirmation sentence
  top = tableTop + tableH + 11;
  for (const l of wrapText(`Total Amount: ${pesosInWords(total)}`, RIGHT - 65, (s) => regular.widthOfTextAtSize(s, 12))) {
    text(page, l, 65, top, regular, 12);
    top += 17;
  }
  top += 16;
  const confirm = `By signing below, I confirm that I have received the payments listed above from ${RECEIPT_DEFAULTS.company}.`;
  for (const l of wrapText(confirm, RIGHT - 65, (s) => regular.widthOfTextAtSize(s, 12))) {
    text(page, l, 65, top, regular, 12);
    top += 16;
  }

  // Signature blocks
  top += 24;
  text(page, 'RELEASED AND PREPARED BY:', 66, top, regular, 12);
  text(page, 'RECEIVED & ACKNOWLEDGED BY:', 304, top + 11, regular, 12);
  if (data.include_signature) {
    const sw = 100;
    const sh = (sw * signature.height) / signature.width;
    page.drawImage(signature, { x: 64, y: H - (top + 52), width: sw, height: sh, opacity: 0.9 });
  }
  const sigTop = top + 33;
  [data.signatory.name, data.signatory.title, data.signatory.org].forEach((s, i) => text(page, s.toUpperCase(), 66, sigTop + i * 16.5, regular, 12));
  [data.recipient_name, data.recipient_title].forEach((s, i) => text(page, s.toUpperCase(), 304, sigTop + 11 + i * 16.5, regular, 12));
  // A line to sign on, above the recipient's name.
  page.drawLine({ start: { x: 304, y: H - (sigTop + 7) }, end: { x: 504, y: H - (sigTop + 7) }, thickness: 0.5, color: MUTED });

  const disclaimer = 'THIS DOCUMENT SERVES AS AN ACKNOWLEDGMENT OF PAYMENT RECEIVED AND IS NOT AN OFFICIAL BIR INVOICE.';
  text(page, disclaimer, 59, sigTop + 61, italic, 8, BLACK);

  // Footer
  text(page, data.contact.phone, 60, 770, regular, 10, BLACK);
  text(page, data.contact.email, RIGHT - regular.widthOfTextAtSize(data.contact.email, 10), 770, regular, 10, BLACK);

  return doc.save();
}

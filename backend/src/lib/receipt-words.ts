/**
 * Pure helpers for the payment acknowledgment receipt: amount in words, the
 * peso format, receipt numbers, and the date style the receipt uses.
 *
 * Kept free of asset imports so tests run under tsx (which has no binary
 * loader); the renderer is in acknowledgment-receipt.ts.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion'];

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r]! : TENS[Math.floor(r / 10)]! + (r % 10 ? `-${ONES[r % 10]}` : ''));
  return parts.join(' ');
}

/** 52290 → "Fifty-Two Thousand Two Hundred Ninety". */
export function integerToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Cannot spell ${n}`);
  if (n === 0) return 'Zero';
  const groups: string[] = [];
  let i = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) groups.unshift(`${under1000(chunk)}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
    n = Math.floor(n / 1000);
    i += 1;
  }
  return groups.join(' ');
}

/**
 * The receipt's "Total Amount" line, in the form the existing receipts use:
 * 5229004 → "Fifty-Two Thousand Two Hundred Ninety Pesos and 04/100 Only."
 */
export function pesosInWords(centavos: number): string {
  const pesos = Math.floor(centavos / 100);
  const cents = String(centavos % 100).padStart(2, '0');
  return `${integerToWords(pesos)} ${pesos === 1 ? 'Peso' : 'Pesos'} and ${cents}/100 Only.`;
}

/** 5229004 → "₱52,290.04". */
export function peso(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-09-25' → 'Sep 25, 2026' (the table's date style). */
export function shortDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

/** '2026-10-15' → '15 October 2026' (the header's date style). */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

/** 'HC-AR-2026-0007' — sequence is per calendar year. */
export function receiptNumber(year: number, seq: number): string {
  return `HC-AR-${year}-${String(seq).padStart(4, '0')}`;
}

/** Greedy word wrap by a width function (the PDF font's measure). */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(next) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

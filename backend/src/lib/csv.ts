/**
 * CSV responses.
 *
 * Extracted from admin-registrations.ts when the People export became the
 * second thing here that hands an operator a spreadsheet. Two copies of the
 * quoting rule is two chances to get one of them wrong, and the failure is
 * silent: a name with a comma in it does not error, it just shifts every
 * column after it by one.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';

/** RFC 4180 quoting: double the quotes, wrap anything with a separator in them. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `Return to Self` → `return-to-self`, for a filename. */
export const csvSlug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A downloadable CSV, header row first.
 *
 * The body opens with a BOM so Excel reads it as UTF-8 — without it a name
 * with a ñ in it arrives mangled, which is not a detail to get wrong on a list
 * of people's names.
 */
export function csvResponse(
  filename: string,
  header: unknown[],
  rows: unknown[][],
): APIGatewayProxyResultV2 {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? '*',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: `﻿${lines.join('\r\n')}`,
  };
}

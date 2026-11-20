/** Admin community list: filters and CSV shape (Canny: Community Sign-Ups – Database & CSV Export). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterSignups, signupCsvRows, type SignupRow } from '../handlers/admin-community.js';

const row = (o: Partial<SignupRow>): SignupRow => ({
  id: 'x', email: 'a@x.com', first_name: 'Ann', last_name: 'Lee', interests: [], messages: [],
  marketing_consent: false, marketing_consent_at: null, marketing_consent_withdrawn_at: null,
  source: 'form', submission_count: 1, first_submitted_at: '2026-01-01T00:00:00Z', last_submitted_at: '2026-01-01T00:00:00Z',
  ...o,
});
const rows = [
  row({ id: '1', email: 'ann@x.com', interests: ['Retreats'], marketing_consent: true }),
  row({ id: '2', email: 'bo@y.com', first_name: 'Bo', interests: ['Classes', 'Workshops'], messages: [{ at: '2026-01-02T00:00:00Z', text: 'Breathwork please' }] }),
  row({ id: '3', email: 'cy@z.com', first_name: 'Cy', source: 'import' }),
];

describe('filterSignups', () => {
  it('filters by consent', () => {
    assert.deepEqual(filterSignups(rows, { consent: 'yes' }).map((r) => r.id), ['1']);
    assert.deepEqual(filterSignups(rows, { consent: 'no' }).map((r) => r.id), ['2', '3']);
  });
  it('filters by interest, case-insensitively', () => {
    assert.deepEqual(filterSignups(rows, { interest: 'workshops' }).map((r) => r.id), ['2']);
  });
  it('searches name, email and message text', () => {
    assert.deepEqual(filterSignups(rows, { q: 'breath' }).map((r) => r.id), ['2']);
    assert.deepEqual(filterSignups(rows, { q: 'CY@' }).map((r) => r.id), ['3']);
  });
  it('filters by source', () => {
    assert.deepEqual(filterSignups(rows, { source: 'import' }).map((r) => r.id), ['3']);
  });
});

describe('signupCsvRows', () => {
  it('has one line per person with consent and joined interests', () => {
    const { header, lines } = signupCsvRows(rows);
    assert.equal(lines.length, 3);
    const c = header.indexOf('Marketing consent');
    assert.equal(lines[0]![c], 'Yes');
    assert.equal(lines[1]![header.indexOf('Interests')], 'Classes; Workshops');
    assert.equal(lines[1]![header.indexOf('Latest message')], 'Breathwork please');
  });
});

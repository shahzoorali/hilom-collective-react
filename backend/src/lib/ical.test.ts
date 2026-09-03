/**
 * Tests for the iCalendar serialiser.
 *
 * `node:test` via tsx, matching the sibling test files.
 *
 * The reason these exist at all: iCalendar failures are silent and remote. A
 * malformed line does not raise anything here — it produces a file that some
 * calendar app, on someone else's machine, quietly refuses to parse, and the
 * only symptom is a facilitator saying "the calendar thing doesn't work". The
 * three rules with a precise right answer (escaping, 75-*octet* folding, UTC
 * timestamps) are therefore pinned exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, foldLine, toIcsDate, renderCalendar } from './ical.js';

describe('escapeText — RFC 5545 §3.3.11', () => {
  it('escapes the three special characters', () => {
    assert.equal(escapeText('a;b,c\\d'), 'a\\;b\\,c\\\\d');
  });

  it('escapes the backslash first, so it does not double the others', () => {
    // A naive order turns ";" into "\;" and then that backslash into "\\;".
    assert.equal(escapeText(';'), '\\;');
  });

  it('turns a newline into the two-character escape', () => {
    assert.equal(escapeText('one\ntwo'), 'one\\ntwo');
  });

  it('drops a carriage return rather than emitting a stray escape', () => {
    assert.equal(escapeText('one\r\ntwo'), 'one\\ntwo');
  });
});

describe('foldLine — 75 octets, never mid-character', () => {
  it('leaves a short line alone', () => {
    assert.equal(foldLine('SUMMARY:Hello'), 'SUMMARY:Hello');
  });

  it('folds with CRLF and a leading space', () => {
    const folded = foldLine('SUMMARY:' + 'a'.repeat(100));
    assert.ok(folded.includes('\r\n '));
    // Unfolding is: remove every CRLF-plus-space.
    assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + 'a'.repeat(100));
  });

  it('measures octets, not characters', () => {
    // 40 three-byte characters is 120 octets — well over the limit, even
    // though it is only 40 characters long.
    const line = 'SUMMARY:' + '漢'.repeat(40);
    const folded = foldLine(line);
    assert.ok(folded.includes('\r\n '), 'a 120-octet line should have folded');
    for (const segment of folded.split('\r\n')) {
      assert.ok(
        new TextEncoder().encode(segment).length <= 75,
        `segment of ${new TextEncoder().encode(segment).length} octets exceeds 75`,
      );
    }
  });

  it('never splits a multi-byte character', () => {
    // The failure this guards: cutting at byte 75 mid-sequence, which arrives
    // in the calendar app as replacement characters.
    const folded = foldLine('DESCRIPTION:' + 'é'.repeat(60));
    assert.equal(folded.replace(/\r\n /g, ''), 'DESCRIPTION:' + 'é'.repeat(60));
    assert.ok(!folded.includes('�'));
  });

  it('survives an emoji, which is a surrogate pair in JS but one character', () => {
    const folded = foldLine('SUMMARY:' + '🌿'.repeat(30));
    assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + '🌿'.repeat(30));
  });
});

describe('toIcsDate', () => {
  it('renders a UTC basic-format timestamp', () => {
    assert.equal(toIcsDate('2026-03-12T07:00:00.000Z'), '20260312T070000Z');
  });

  it('normalises an offset time to UTC', () => {
    assert.equal(toIcsDate(new Date('2026-03-12T15:00:00+08:00')), '20260312T070000Z');
  });
});

describe('renderCalendar', () => {
  const event = {
    uid: 'booking-abc@hilomcollective.com',
    startsAt: '2026-03-12T07:00:00Z',
    endsAt: '2026-03-12T08:00:00Z',
    summary: 'Session — Maya',
  };

  it('wraps events in a VCALENDAR and terminates every line with CRLF', () => {
    const ics = renderCalendar({ name: 'Hilom', events: [event] });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(ics.includes('BEGIN:VEVENT\r\n'));
    // A bare LF anywhere is what Outlook rejects the whole file over.
    assert.doesNotMatch(ics.replace(/\r\n/g, ''), /\n/);
  });

  it('carries the fields a client needs to match and update an event', () => {
    const ics = renderCalendar({ name: 'Hilom', events: [{ ...event, sequence: 42 }] });
    assert.ok(ics.includes('UID:booking-abc@hilomcollective.com'));
    assert.ok(ics.includes('DTSTART:20260312T070000Z'));
    assert.ok(ics.includes('DTEND:20260312T080000Z'));
    assert.ok(ics.includes('SEQUENCE:42'));
    assert.ok(ics.includes('STATUS:CONFIRMED'));
  });

  it('emits a cancellation rather than omitting the event', () => {
    // Dropping it would leave a subscriber showing a session that is not
    // happening; STATUS:CANCELLED is what actually clears it.
    const ics = renderCalendar({ name: 'Hilom', events: [{ ...event, status: 'CANCELLED' }] });
    assert.ok(ics.includes('STATUS:CANCELLED'));
    assert.ok(ics.includes('UID:booking-abc@hilomcollective.com'));
  });

  it('escapes a summary that would otherwise break the line grammar', () => {
    const ics = renderCalendar({
      name: 'Hilom',
      events: [{ ...event, summary: 'Coaching; deep work, part 1' }],
    });
    assert.ok(ics.includes('SUMMARY:Coaching\\; deep work\\, part 1'));
  });

  it('publishes the join link as both URL and LOCATION', () => {
    const ics = renderCalendar({
      name: 'Hilom',
      events: [{ ...event, url: 'https://meet.example.com/abc' }],
    });
    assert.ok(ics.includes('URL:https://meet.example.com/abc'));
    assert.ok(ics.includes('LOCATION:https://meet.example.com/abc'));
  });

  it('is valid with no events at all', () => {
    const ics = renderCalendar({ name: 'Hilom', events: [] });
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(!ics.includes('BEGIN:VEVENT'));
  });
});

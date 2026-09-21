/**
 * The calendar invite attached to event-registration emails.
 *
 * Worth testing rather than eyeballing: a malformed .ics does not error, it is
 * silently ignored by the mail client, so the failure mode is "nobody's
 * calendar entry appeared" discovered weeks later by nobody reporting it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registrationInvite, type EmailEvent } from './registration-email.js';

const baseEvent: EmailEvent = {
  title: 'Monday: Online HIIT Pilates Express with Prem',
  starts_at: '2026-09-21T01:00:00.000Z',
  ends_at: '2026-09-21T01:30:00.000Z',
  location: 'Zoom',
  venue_details: null,
  format: 'virtual',
  join_url: 'https://us05web.zoom.us/j/9233119862?pwd=abc',
  join_instructions: 'Waiting room opens 15 minutes early.',
};

const invite = (event: EmailEvent, sequence = 0) =>
  registrationInvite({
    registrationId: 'reg-123',
    event,
    attendeeEmail: 'someone@example.com',
    attendeeName: 'Someone Example',
    sequence,
  });

const body = (event: EmailEvent, sequence = 0): string => {
  const att = invite(event, sequence);
  assert.ok(att, 'expected an attachment');
  return new TextDecoder().decode(att.content);
};

/**
 * Undo RFC 5545 line folding.
 *
 * Any line over 75 octets is split and continued with a leading space, so a
 * long ATTENDEE or DESCRIPTION is spread over several physical lines. Matching
 * the raw text for a property value is therefore wrong — as this test suite
 * first did, reporting a bug that was actually correct folding.
 */
const unfold = (ics: string): string => ics.split('\r\n ').join('');

describe('registrationInvite', () => {
  it('is a well-formed single-event REQUEST calendar', () => {
    const ics = body(baseEvent);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
    assert.match(ics, /METHOD:REQUEST/);
    assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 1);
    // CRLF throughout, which RFC 5545 requires and some clients enforce.
    assert.ok(!/[^\r]\n/.test(ics), 'found a bare LF');
  });

  it('carries the real start and end, in UTC', () => {
    const ics = body(baseEvent);
    assert.match(ics, /DTSTART:20260921T010000Z/);
    assert.match(ics, /DTEND:20260921T013000Z/);
  });

  it('gives an hour to an event with no end time rather than zero length', () => {
    // Nullable column; a zero-length entry is dropped silently by some clients.
    const ics = body({ ...baseEvent, ends_at: null });
    assert.match(ics, /DTSTART:20260921T010000Z/);
    assert.match(ics, /DTEND:20260921T020000Z/);
  });

  it('keys the UID to the registration, not the event', () => {
    // Two people at the same event hold two entries; one declining must not
    // touch the other's.
    assert.match(body(baseEvent), /UID:event-registration-reg-123@hilomcollective\.com/);
  });

  it('puts the joining link in LOCATION and URL', () => {
    const ics = body(baseEvent);
    assert.match(ics, /LOCATION:https:\/\/us05web\.zoom\.us/);
    assert.match(ics, /URL:https:\/\/us05web\.zoom\.us/);
  });

  it('falls back to the venue when there is no link', () => {
    const ics = body({ ...baseEvent, join_url: null });
    assert.match(ics, /LOCATION:Zoom/);
    assert.ok(!ics.includes('zoom.us'), 'leaked a join link that was not set');
  });

  it('addresses the attendee so a client draws RSVP controls', () => {
    const ics = unfold(body(baseEvent));
    assert.match(ics, /ATTENDEE;CN=Someone Example;.*RSVP=TRUE:mailto:someone@example\.com/);
    assert.match(ics, /ORGANIZER;CN=Hilom Collective:mailto:kumusta@hilomcollective\.com/);
  });

  it('carries a later sequence when re-issued, so calendars update in place', () => {
    assert.match(body(baseEvent, 0), /SEQUENCE:0/);
    assert.match(body(baseEvent, 1_700_000_000), /SEQUENCE:1700000000/);
  });

  it('is attached as text/calendar with the method, which is what clients read', () => {
    const att = invite(baseEvent);
    assert.ok(att);
    assert.equal(att.filename, 'invite.ics');
    assert.match(att.contentType, /^text\/calendar;.*method=REQUEST$/);
  });
});

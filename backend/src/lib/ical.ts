/**
 * iCalendar (RFC 5545) serialisation, kept to the subset a subscribable feed
 * actually needs.
 *
 * Written by hand rather than pulled from npm. The format's genuinely fiddly
 * parts are few and small — escaping, 75-octet line folding, and UTC
 * timestamps — and each is a handful of lines with a rule that can be stated
 * exactly. A dependency here would be a Lambda bundle and a supply chain in
 * exchange for about eighty lines.
 *
 * Everything emitted is UTC (`DTSTART:...Z`), so there are no VTIMEZONE
 * components and no timezone database to keep current. Bookings are stored as
 * instants; the facilitator's calendar app renders them in whatever zone that
 * client is set to, which is exactly the behaviour wanted — a facilitator
 * travelling sees their sessions move with them.
 */

/**
 * Escapes a value for a text property.
 *
 * Per RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, and a
 * literal newline becomes `\n`. Backslash goes first — escaping it after the
 * others would double the backslashes they introduced.
 *
 * Carriage returns are dropped rather than escaped: a lone CR has no
 * representation in the format, and CRLF pairs would otherwise produce a
 * stray `\n` preceded by nothing.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}

/**
 * Folds a content line to 75 octets, per RFC 5545 §3.1.
 *
 * The limit is on *octets*, not characters, and the split must not fall inside
 * a multi-byte sequence — a session title with an emoji or an é in it would
 * otherwise be cut in half and arrive as replacement characters. So this
 * measures in UTF-8 bytes and only ever breaks on a character boundary.
 *
 * Continuation lines begin with a single space, which the parser strips.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  // A continuation line's leading space counts against its own 75.
  let limit = 75;

  // Iterating the string yields whole code points, so a surrogate pair is
  // never split; combining marks may still separate from their base character,
  // which is legal and renders correctly.
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += size;
  }
  out.push(current);

  return out.join('\r\n ');
}

/** An instant as an iCalendar UTC date-time: `20260312T070000Z`. */
export function toIcsDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

export interface IcsEvent {
  /**
   * Globally unique and *stable* across regenerations of the feed. Calendar
   * clients match on this: a UID that changed between fetches would make every
   * session vanish and reappear as a new one, taking any alarm the facilitator
   * set with it. The booking's id is the natural key.
   */
  uid: string;
  startsAt: string | Date;
  endsAt: string | Date;
  summary: string;
  description?: string | null;
  /** Joining link, surfaced as both URL and LOCATION so clients show it. */
  url?: string | null;
  /**
   * Bumped whenever the event's details change, so a client knows this
   * version supersedes the one it holds. `bookings.updated_at` is not a
   * counter, so the epoch second of the last update stands in for one — it is
   * monotonic per event, which is all the field is required to be.
   */
  sequence?: number;
  /** `CANCELLED` tells subscribers to remove an event they already have. */
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
}

export interface IcsCalendar {
  /** Shown as the calendar's name in most clients. */
  name: string;
  events: IcsEvent[];
  /** Hint to clients about how often to re-fetch. */
  refreshIntervalMinutes?: number;
}

/**
 * Renders a full VCALENDAR document.
 *
 * Lines are joined with CRLF because the specification requires it, and some
 * clients — Outlook notably — reject a bare-LF file outright.
 */
export function renderCalendar(calendar: IcsCalendar): string {
  const stamp = toIcsDate(new Date());
  const refresh = calendar.refreshIntervalMinutes ?? 60;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hilom Collective//Facilitator Sessions//EN',
    'CALSCALE:GREGORIAN',
    // Read-only: a client that honours this will not offer to edit events that
    // have nowhere to be written back to.
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    // The standard property and the Apple/Google one. Both are hints.
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`,
    `X-PUBLISHED-TTL:PT${refresh}M`,
  ];

  for (const event of calendar.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDate(event.startsAt)}`,
      `DTEND:${toIcsDate(event.endsAt)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `STATUS:${event.status ?? 'CONFIRMED'}`,
      `SEQUENCE:${event.sequence ?? 0}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.url) {
      lines.push(`URL:${escapeText(event.url)}`);
      // Not redundant: many clients show LOCATION on the event chip and only
      // reveal URL once it is opened, and the link is the thing someone needs
      // at a glance thirty seconds before a session.
      lines.push(`LOCATION:${escapeText(event.url)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Sanitizes a value used inside an iCalendar parameter (`CN=...`, not a
 * property value).
 *
 * Parameter values containing `:`, `;` or `,` are legal only quoted, and a
 * quoted value cannot itself contain a `"`. Rather than implement RFC 5545's
 * quoting rules for what is always a short display name, the handful of
 * characters that would require quoting are stripped — a name with a comma in
 * it loses the comma, not the whole invite.
 */
function sanitizeParam(value: string): string {
  return value.replace(/[":;,]/g, '').trim();
}

export type InviteMethod = 'REQUEST' | 'CANCEL';

export interface InviteParty {
  email: string;
  /** Falls back to the email if blank, so ORGANIZER/ATTENDEE always has a CN. */
  name?: string | null;
}

export interface InviteInput {
  /**
   * `REQUEST` proposes or updates a meeting — sent on confirmation and on
   * reschedule, with `sequence` bumped so the calendar app knows this
   * supersedes what it already has. `CANCEL` withdraws it.
   */
  method: InviteMethod;
  /**
   * Stable across the booking's lifetime — the same value the subscribable
   * feed uses (`booking-<id>@hilomcollective.com`) — so a calendar app that
   * received the confirmation, the reschedule and the cancellation treats
   * them as the same event moving through states rather than three different
   * events.
   */
  uid: string;
  /** Monotonically increasing across REQUEST/CANCEL for the same UID. */
  sequence: number;
  startsAt: string | Date;
  endsAt: string | Date;
  summary: string;
  description?: string | null;
  /** Joining link, surfaced as both URL and LOCATION. */
  location?: string | null;
  organizer: InviteParty;
  attendee: InviteParty;
}

/**
 * A single-event VCALENDAR with `METHOD:REQUEST` or `METHOD:CANCEL` — the
 * two values Gmail and Outlook actually look for before they render an
 * message as a calendar invite (with Yes/No/Maybe buttons) rather than as an
 * email with an attachment. `METHOD:PUBLISH`, which the subscribable feed
 * uses, is read-only by design and deliberately does not trigger this.
 *
 * ORGANIZER is always the facilitator and ATTENDEE the client — the same
 * file is attached to both parties' copies of the email; a calendar app
 * shows each recipient their own RSVP controls, and recipients who are not
 * the ATTENDEE (the facilitator, on their own invite) still get an
 * informational entry.
 */
export function renderInvite(input: InviteInput): string {
  const stamp = toIcsDate(new Date());

  const organizerName = sanitizeParam(input.organizer.name || input.organizer.email);
  const attendeeName = sanitizeParam(input.attendee.name || input.attendee.email);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hilom Collective//Facilitator Sessions//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(input.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcsDate(input.startsAt)}`,
    `DTEND:${toIcsDate(input.endsAt)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    `ORGANIZER;CN=${organizerName}:mailto:${input.organizer.email}`,
    // RSVP=TRUE and PARTSTAT=NEEDS-ACTION are what make Gmail/Outlook draw the
    // Yes/No/Maybe buttons for the attendee; without them some clients render
    // the file as a plain attachment instead of an invite to respond to.
    `ATTENDEE;CN=${attendeeName};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${input.attendee.email}`,
  ];

  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.location) {
    lines.push(`URL:${escapeText(input.location)}`);
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

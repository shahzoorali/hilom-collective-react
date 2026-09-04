/**
 * "Add to calendar" for one session — a small menu of web links plus a
 * downloadable `.ics`, shown wherever a booking appears: the confirmation
 * screen, the client's own bookings, and the facilitator's dashboard.
 *
 * This is deliberately the belt to the invite email's braces. The
 * confirmation, reschedule and cancellation emails already carry a
 * `text/calendar; method=REQUEST` attachment that Gmail and Outlook auto-
 * render as an invite with Accept/Decline buttons — see
 * `backend/src/lib/email-mime.ts` and `renderInvite` in `ical.ts`. But not
 * every client honours that (Apple Mail on iOS is inconsistent about it, and
 * a webmail client viewed on a phone browser rather than its own app often
 * shows the .ics as a bare attachment), and someone looking at a booking on
 * the dashboard hours after the email arrived has nothing to click in an
 * inbox at all. This component is the same event, offered directly.
 *
 * The three web links (Google, Outlook, Yahoo) need no file — they are a URL
 * with the event encoded in the query string, so "Add to Google Calendar"
 * opens Google's own compose screen pre-filled. The download covers Apple
 * Calendar and desktop Outlook, neither of which has a web compose URL.
 */
import { useEffect, useRef, useState } from 'react';

export interface CalendarEvent {
  /** Used as the .ics filename and to keep the UID stable if this is ever downloaded twice. */
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  location?: string | null;
}

/** `YYYYMMDDTHHMMSSZ`, what every one of these URL formats and the .ics both want. */
function utcStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function googleUrl(ev: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${utcStamp(ev.startsAt)}/${utcStamp(ev.endsAt)}`,
    details: ev.description ?? '',
    location: ev.location ?? '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Covers both outlook.live.com (personal) and outlook.office.com (work/school) accounts. */
function outlookUrl(ev: CalendarEvent, host: 'live' | 'office'): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: ev.title,
    startdt: ev.startsAt,
    enddt: ev.endsAt,
    body: ev.description ?? '',
    location: ev.location ?? '',
  });
  return `https://outlook.${host === 'live' ? 'live' : 'office'}.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function yahooUrl(ev: CalendarEvent): string {
  // Yahoo wants a duration rather than an end time.
  const minutes = Math.max(
    1,
    Math.round((new Date(ev.endsAt).getTime() - new Date(ev.startsAt).getTime()) / 60_000),
  );
  const params = new URLSearchParams({
    v: '60',
    title: ev.title,
    st: utcStamp(ev.startsAt),
    dur: String(Math.floor(minutes / 60)).padStart(2, '0') + String(minutes % 60).padStart(2, '0'),
    desc: ev.description ?? '',
    in_loc: ev.location ?? '',
  });
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

/**
 * A minimal single-event .ics — enough for Apple Calendar and desktop
 * Outlook to import directly. This is a plain `METHOD:PUBLISH`-style file
 * (no ORGANIZER/ATTENDEE), unlike the invite attached to the emails: a
 * client clicking "Download" here is adding the event to *their own*
 * calendar, not responding to an invitation, so there is nothing to RSVP to.
 */
function buildIcs(ev: CalendarEvent): string {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hilom Collective//Booking//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:booking-${ev.id}@hilomcollective.com`,
    `DTSTAMP:${utcStamp(new Date().toISOString())}`,
    `DTSTART:${utcStamp(ev.startsAt)}`,
    `DTEND:${utcStamp(ev.endsAt)}`,
    `SUMMARY:${escape(ev.title)}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escape(ev.description)}`);
  if (ev.location) {
    lines.push(`URL:${escape(ev.location)}`);
    lines.push(`LOCATION:${escape(ev.location)}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function downloadIcs(ev: CalendarEvent) {
  const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${ev.title.replace(/[^\w-]+/g, '-').slice(0, 60) || 'session'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked after a tick rather than immediately — some browsers cancel the
  // download if the object URL disappears before the click is processed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AddToCalendar({
  event,
  label = 'Add to calendar',
  small = false,
}: {
  event: CalendarEvent;
  label?: string;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options: { label: string; run: () => void }[] = [
    { label: 'Google Calendar', run: () => window.open(googleUrl(event), '_blank', 'noopener') },
    { label: 'Outlook.com', run: () => window.open(outlookUrl(event, 'live'), '_blank', 'noopener') },
    { label: 'Office 365', run: () => window.open(outlookUrl(event, 'office'), '_blank', 'noopener') },
    { label: 'Yahoo Calendar', run: () => window.open(yahooUrl(event), '_blank', 'noopener') },
    { label: 'Apple Calendar / Outlook (.ics file)', run: () => downloadIcs(event) },
  ];

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={small ? 'btn btn-ghost small' : 'btn btn-ghost'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label} {open ? '▲' : '▾'}
      </button>

      {open && (
        <div
          role="menu"
          className="panel"
          style={{
            position: 'absolute',
            zIndex: 20,
            top: 'calc(100% + 0.35rem)',
            left: 0,
            minWidth: '15rem',
            padding: '0.4rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
          }}
        >
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              role="menuitem"
              className="btn btn-ghost small"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => {
                o.run();
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

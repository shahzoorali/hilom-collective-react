-- Google Calendar event id for a booking, independent of meeting_external_id
-- (a booking can have a Zoom meeting and a Calendar event at once).
alter table public.bookings
  add column calendar_event_id text;

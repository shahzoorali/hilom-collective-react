-- Record the client's timezone on the booking.
--
-- Every time the platform has ever rendered for a booking has been in the
-- facilitator's zone — the emails hardcode it, and the dashboards fall back to
-- whatever zone the browser happens to be in. Neither side has ever been shown
-- the *other* party's time. A Manila facilitator and a Sydney client are the
-- normal case here, not the exception, and one of them is always doing the
-- three-hour arithmetic that ends in an empty meeting room.
--
-- Showing both requires knowing both, and the client's was simply never
-- captured: facilitators have `timezone` on their row (it drives the whole slot
-- engine), clients have no row at all — they are an email on a booking, by the
-- same design that keeps course buyers out of the user table.
--
-- So it lives here, on the booking, which is also the right grain: someone who
-- books from Manila in March and from Lisbon in June was genuinely in two
-- places, and each session should say so.
--
-- Nullable. An IANA name sent by the browser at booking time, and there is no
-- honest default for a row written before this migration or by a client whose
-- browser did not report one — "assume Manila" would print a confident, wrong
-- second time, which is worse than printing one time and labelling it.
alter table public.bookings
  add column if not exists client_timezone text;

-- No RLS change: `bookings` is backend-only.

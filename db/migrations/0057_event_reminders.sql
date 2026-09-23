-- Reminds a confirmed registrant that the event is coming up (0054, phase 2).
--
-- `registration-sweep.ts` already reminds people about a *payment* on four
-- tiers, backed by `registration_charge_reminders` (0017) because a charge can
-- be reminded about more than once as it moves through those tiers. A
-- "the event starts tomorrow" reminder is a different shape: it fires once,
-- ever, per registration, the same one-shot rule `bookings.reminder_sent_at`
-- already uses for sessions. One boolean-ish column is enough; a second
-- reminders table would be solving a problem this reminder doesn't have.
alter table public.event_registrations
  add column if not exists reminder_sent_at timestamptz;

comment on column public.event_registrations.reminder_sent_at is
  'When the "coming up" reminder went out (0054). One-shot — unlike the '
  'per-charge payment reminders in registration_charge_reminders, this event '
  'has only one occurrence to be reminded about.';

-- The sweep's scan: confirmed, unreminded, starting soon.
create index if not exists event_registrations_reminder_idx
  on public.event_registrations (status)
  where reminder_sent_at is null and status = 'confirmed';

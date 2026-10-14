-- Delivery tracking for automatic payment reminders.
--
-- A reminder row used to mean only "handed to SES". SES now reports what
-- happened next (delivered, bounced, complained, rejected) through a
-- configuration set's event destination; the ses-events Lambda writes the
-- latest outcome here, matched on the SES message id stored at send time.

alter table public.registration_charge_reminders
  add column if not exists ses_message_id      text,
  add column if not exists delivery_status     text
    check (delivery_status in ('sent', 'delivered', 'bounced', 'complained', 'rejected', 'delayed')),
  add column if not exists delivery_detail     text,
  add column if not exists delivery_updated_at timestamptz;

create index if not exists registration_charge_reminders_ses_message_id_idx
  on public.registration_charge_reminders (ses_message_id)
  where ses_message_id is not null;

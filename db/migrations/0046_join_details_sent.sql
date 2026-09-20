-- Remember whether a registrant has already been told how to join.
--
-- The joining-details email comes in two wordings, and which one is correct is
-- a per-person question, not a per-event one:
--
--   * never told           -> "Here is how to join X"
--   * told, link since changed -> "The link has changed, ignore the earlier one"
--
-- Until now the send hardcoded the second. That is right for the case it was
-- built for and wrong for the case that actually happened first: the two people
-- who registered before the link existed were told to ignore an earlier email
-- they had never received.
--
-- Inferring it from "did join_url change on the last save?" was the cheap
-- alternative and is wrong in the same way, one step removed — it is still one
-- answer for everyone on the roster, so a person who registers *after* a link
-- change and is then included in the next send gets the "ignore the earlier
-- link" copy for a link they were never sent. The question is per-registrant,
-- so the state belongs on the registration.
--
-- Nullable with no default: null means "never sent", which is the correct and
-- honest state for every row that already exists, including the two that were
-- emailed by hand before this column existed. Those two are backfilled
-- explicitly below rather than left to be told to ignore an email they did get.

alter table public.event_registrations
  add column if not exists join_details_sent_at timestamptz;

comment on column public.event_registrations.join_details_sent_at is
  'When the joining details were last emailed to this registrant. Null means never. '
  'Decides first-time vs "the link has changed" wording in sendJoinDetails.';

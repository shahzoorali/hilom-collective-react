-- Pre-session intake.
--
-- A client books and gets a meeting link. There is no "fill this in first" —
-- no health questionnaire, no consent to a scope of practice, no "what do you
-- want from this session". The only thing carried across is `client_notes`, a
-- single optional free-text box on the booking form, which is not a form so
-- much as a place to put a sentence.
--
-- For wellness work this is often clinically material rather than a
-- convenience. A breathwork facilitator needs to know about a heart condition
-- or a pregnancy *before* the session, not in the first five minutes of it,
-- and a somatic practitioner asking "have you worked with this before?" is
-- doing screening, not small talk.
--
-- ---------------------------------------------------------------------------
-- Why jsonb rather than tables
-- ---------------------------------------------------------------------------
-- The obvious relational shape — a questions table and an answers table — buys
-- referential integrity between a question and its answers, and charges for it
-- in a way that is wrong here: editing a question would either rewrite the
-- meaning of answers already given, or require versioning every question to
-- avoid it. What an answered intake actually is, is a *document* — the
-- questions as they were asked, and what this person said — and it must stay
-- readable exactly as it was even after the facilitator rewrites the form.
--
-- So the questions are a jsonb array on the service, the answers are a jsonb
-- array on the booking, and each answered item carries a copy of the label it
-- was answering. Nothing about a later edit can change what a client was asked.
--
-- Question shape (validated in backend/src/lib/facilitator-input.ts):
--   { id, label, help, type: 'text'|'longtext'|'choice'|'checkbox', required, options[] }
-- Answer shape:
--   { id, label, value }   -- value is a string; a checkbox is 'yes' or 'no'
alter table public.facilitator_services
  add column if not exists intake_questions jsonb not null default '[]'::jsonb;

-- Guards the column against anything that is not an array, which is the one
-- structural mistake a bug in the writer could make that every reader would
-- then have to defend against.
do $$ begin
  alter table public.facilitator_services
    add constraint facilitator_services_intake_questions_array
      check (jsonb_typeof(intake_questions) = 'array');
exception when duplicate_object then null;
end $$;

alter table public.bookings
  add column if not exists intake_answers jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.bookings
    add constraint bookings_intake_answers_array
      check (jsonb_typeof(intake_answers) = 'array');
exception when duplicate_object then null;
end $$;

-- When the client last submitted it. Null means "not filled in", which is what
-- the facilitator's booking view and the reminder nudge both key off. Not
-- derived from `intake_answers <> '[]'`: a form whose every question is
-- optional can be legitimately submitted empty, and that is a different fact
-- from never having been opened.
alter table public.bookings
  add column if not exists intake_completed_at timestamptz;

-- The nudge query: confirmed sessions coming up whose intake is still blank.
create index if not exists bookings_intake_pending_idx
  on public.bookings (facilitator_id, starts_at)
  where intake_completed_at is null and status = 'confirmed';

-- ---------------------------------------------------------------------------
-- Disclosure
-- ---------------------------------------------------------------------------
-- Answers can contain health information. `bookings` is backend-only (no anon
-- or authenticated grant), so the only readers are handlers that scope by the
-- verified caller — the client who wrote them and the facilitator running the
-- session. `intake_questions` sits on `facilitator_services`, which *is*
-- publicly selectable, and that is intended: the questions are what someone is
-- about to be asked, and a client deciding whether to book is entitled to see
-- them beforehand. Only the answers are private.

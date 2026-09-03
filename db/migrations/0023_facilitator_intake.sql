-- Facilitator intake: the application form stops being a profile draft.
--
-- Until now `/facilitators/apply` wrote the *public profile* — credentials,
-- specialties, scope of practice, delivery mode — because the facilitators row
-- is both the application and the marketplace listing. The new form asks a
-- different question. It is a triage form: what do you want to build, how
-- involved should Hilom be, how do we reach you. None of that is profile copy,
-- and the profile fields it used to collect are now filled in later, by the
-- facilitator, in the dashboard Profile tab, before an admin publishes them.
--
-- So the profile columns stay exactly as they are and simply arrive empty at
-- `applied`. What is added here is the intake layer beside them.
--
-- Every column is nullable or defaulted. No facilitator has applied through the
-- form yet, so there is nothing to backfill, but rows an admin entered directly
-- (which never had intake answers and never will) must keep working untouched.

-- ---------------------------------------------------------------------------
-- How to reach them
-- ---------------------------------------------------------------------------
-- Free text with a check constraint rather than an enum: these are four values
-- chosen by whoever owns the form copy, and a fifth is a data change here
-- instead of a `create type` dance in a migration. Same call as the arrays
-- below, for the same reason.
alter table public.facilitators
  add column if not exists contact_method text;

do $$ begin
  alter table public.facilitators add constraint facilitators_contact_method_check
    check (contact_method is null or contact_method in
      ('email', 'phone', 'instagram', 'whatsapp'));
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- About their work
-- ---------------------------------------------------------------------------
alter table public.facilitators
  add column if not exists years_experience text;

do $$ begin
  alter table public.facilitators add constraint facilitators_years_experience_check
    check (years_experience is null or years_experience in
      ('under_1', '1_3', '3_5', '5_plus'));
exception when duplicate_object then null;
end $$;

-- "What kind of support do you need?" — the three Hilom service tracks, as
-- shown on the marketing page: design | build_launch | live_experiences.
--
-- An array because the tracks are genuinely not exclusive: someone bringing a
-- course online *and* running workshops wants two of them, which is exactly
-- what the first real application asked for.
--
-- Deliberately NOT required at the database level, and not required by the
-- form either. "What do you have for your programs right now?" offers
-- `not_sure` — "I want Hilom's recommendation" — and an applicant who has just
-- said they cannot pick a track must not then be blocked by a form demanding
-- one. Zero tracks is a real, meaningful answer here, not a missing one.
alter table public.facilitators
  add column if not exists support_needed text[] not null default '{}';

-- "What do you have for your programs right now?" — the applicant's own
-- starting point, in their words rather than Hilom's packaging. Also an array:
-- the first application selected two.
alter table public.facilitators
  add column if not exists program_status text[] not null default '{}';

-- Values for both arrays are validated in the application handler
-- (backend/src/lib/facilitator-input.ts) against an allowlist, not constrained
-- here. A check constraint over array membership would have to be dropped and
-- recreated every time the form copy gains an option, and the option list is
-- owned by marketing, not by the schema.

alter table public.facilitators
  add column if not exists website_url text;

-- ---------------------------------------------------------------------------
-- Certification / affiliation document
-- ---------------------------------------------------------------------------
-- The S3 *key*, never a URL — and pointedly not a media_assets row.
--
-- A credential document is somebody's personal record: a diploma, a licence, a
-- certification with their full legal name on it. media_assets exists to hold
-- things that get served from the public CDN, and putting a PDF like this
-- there would publish it to anyone who guessed or was given the URL. It lives
-- under a private prefix instead, and admin reads it through a short-lived
-- signed URL generated at review time.
--
-- Optional: not every practitioner in this field holds a paper credential, and
-- the review reads it alongside their stated experience rather than gating on
-- it.
alter table public.facilitators
  add column if not exists cert_document_key text;

alter table public.facilitators
  add column if not exists cert_document_name text;

-- ---------------------------------------------------------------------------
-- Where they came from
-- ---------------------------------------------------------------------------
-- A slug from the form's select, plus the free-text box behind its "Other"
-- option. Two columns rather than one so the common answers stay countable —
-- the first real application answered this with a person's name, which is
-- precisely the case that needs somewhere to go without turning the whole
-- field into unaggregatable prose.
alter table public.facilitators
  add column if not exists referral_source text;

alter table public.facilitators
  add column if not exists referral_source_other text;

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------
-- A timestamp and a version, not a boolean.
--
-- `true` cannot answer either question that a consent record exists to answer:
-- when did they agree, and what did they agree to? Both matter precisely when
-- somebody disputes it, which is the only time anyone reads this column.
-- Null means the row predates the consent checkbox (an admin-entered
-- facilitator), not that consent was refused — a refused form is never
-- submitted at all.
alter table public.facilitators
  add column if not exists privacy_accepted_at timestamptz;

alter table public.facilitators
  add column if not exists privacy_policy_version text;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The admin queue filter: "show me everyone who wants help with live
-- experiences". Mirrors facilitators_specialties_idx from 0011.
create index if not exists facilitators_support_needed_idx
  on public.facilitators using gin (support_needed);

create index if not exists facilitators_program_status_idx
  on public.facilitators using gin (program_status);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Nothing here is added to the anon/authenticated column grant from 0011.
--
-- That grant is an explicit allowlist of the columns a published profile
-- exposes, so new columns are private by default and this block is a note
-- rather than a statement. It is written down because the failure mode is
-- silent: adding one of these to that grant later, to make some admin screen
-- easier, would publish an applicant's phone-adjacent contact preference,
-- their referral source and their consent record to the public directory
-- query. None of it is profile copy and none of it should ever be readable by
-- anon.
--
-- service_role already holds table-level select/insert/update/delete on
-- facilitators from 0011, which covers every column added here.

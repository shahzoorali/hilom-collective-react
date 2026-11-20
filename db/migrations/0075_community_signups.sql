-- Community sign-ups ("Join Our Community" form), stored rather than only
-- emailed to kumusta@ (Canny: "Community Sign-Ups – Database & CSV Export").
--
-- One row per email address. A repeat submission updates the row:
--   * interests are merged (union), never replaced
--   * each non-empty message is appended to `messages` with its date
--   * name follows the most recent submission
--   * marketing consent is opt-in and sticky: ticking the box once records
--     consent and its date; a later submission without the tick does NOT
--     withdraw it (an unticked optional box is not a withdrawal). Withdrawal
--     is an admin action that sets consent false and stamps
--     marketing_consent_withdrawn_at.
--
-- `source` is 'form' for live submissions, 'import' for rows backfilled from
-- old notification emails (imported with consent = false).

create table if not exists public.community_signups (
  id                              uuid primary key default gen_random_uuid(),
  email                           text not null unique check (email = lower(email)),
  first_name                      text,
  last_name                       text,
  interests                       text[] not null default '{}',
  messages                        jsonb not null default '[]'::jsonb,
  marketing_consent               boolean not null default false,
  marketing_consent_at            timestamptz,
  marketing_consent_withdrawn_at  timestamptz,
  source                          text not null default 'form' check (source in ('form', 'import')),
  submission_count                int not null default 1,
  first_submitted_at              timestamptz not null default now(),
  last_submitted_at               timestamptz not null default now()
);

create index if not exists community_signups_last_submitted_idx
  on public.community_signups (last_submitted_at desc);

alter table public.community_signups enable row level security;
revoke all on public.community_signups from anon, authenticated;
grant select, insert, update, delete on public.community_signups to service_role;

-- Atomic insert-or-merge, so two quick submissions from the same address
-- cannot race each other into a lost interest or message.
create or replace function public.community_signup_upsert(
  p_email      text,
  p_first_name text,
  p_last_name  text,
  p_interests  text[],
  p_message    text,
  p_consent    boolean,
  p_source     text default 'form',
  p_at         timestamptz default now()
) returns table (id uuid, is_new boolean)
language sql
security invoker
set search_path = public
as $$
  insert into public.community_signups as c (
    email, first_name, last_name, interests, messages,
    marketing_consent, marketing_consent_at, source,
    first_submitted_at, last_submitted_at
  ) values (
    lower(trim(p_email)), p_first_name, p_last_name,
    coalesce((select array_agg(distinct i order by i) from unnest(coalesce(p_interests, '{}')) i where i <> ''), '{}'),
    case when coalesce(trim(p_message), '') = '' then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('at', p_at, 'text', trim(p_message))) end,
    coalesce(p_consent, false),
    case when p_consent then p_at end,
    coalesce(p_source, 'form'),
    p_at, p_at
  )
  on conflict (email) do update set
    first_name = case when p_at >= c.last_submitted_at then excluded.first_name else c.first_name end,
    last_name  = case when p_at >= c.last_submitted_at then excluded.last_name  else c.last_name  end,
    interests  = (select coalesce(array_agg(distinct i order by i), '{}') from unnest(c.interests || excluded.interests) i),
    messages   = c.messages || excluded.messages,
    marketing_consent    = c.marketing_consent or excluded.marketing_consent,
    marketing_consent_at = case
      when c.marketing_consent then c.marketing_consent_at
      when excluded.marketing_consent then excluded.marketing_consent_at
      else c.marketing_consent_at end,
    marketing_consent_withdrawn_at = case
      when excluded.marketing_consent and not c.marketing_consent then null
      else c.marketing_consent_withdrawn_at end,
    submission_count   = c.submission_count + 1,
    first_submitted_at = least(c.first_submitted_at, excluded.first_submitted_at),
    last_submitted_at  = greatest(c.last_submitted_at, excluded.last_submitted_at)
  returning c.id, (xmax = 0) as is_new;
$$;

revoke all on function public.community_signup_upsert(text, text, text, text[], text, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.community_signup_upsert(text, text, text, text[], text, boolean, text, timestamptz) to service_role;

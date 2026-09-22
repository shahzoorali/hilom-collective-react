-- People directory — add the sixth source: group-class registrations.
--
-- 0049 added class_registrations and did not touch people_directory (0022).
-- The view's whole value is that it is complete — the one screen built to
-- answer "have we dealt with this person before?" — and a class attendee has
-- been invisible on it since the day group classes shipped. That is a defect
-- introduced by 0049, not a pre-existing gap; docs/admin-dashboard-plan.md §2.
--
-- The new arm matches the shape of the existing five exactly: email, name,
-- cognito_sub, a source tag, seen_at, and paid_centavos. Nothing else in the
-- view changes — same identity rule (lowercased, trimmed email), same
-- security posture, same "derived, never written to" contract.
create or replace view public.people_directory as
with signals as (
  select
    lower(trim(o.buyer_email))                  as email,
    null::text                                  as full_name,
    o.cognito_user_sub                          as cognito_sub,
    'course_order'::text                        as source,
    o.created_at                                as seen_at,
    case
      when o.status in ('fulfilled', 'paid_pending_enrollment') then o.amount_centavos
      else 0
    end                                         as paid_centavos
  from public.orders o

  union all

  select
    lower(trim(r.buyer_email)),
    null::text,
    r.buyer_cognito_sub,
    'event_registration',
    r.created_at,
    coalesce(
      (select sum(c.amount_centavos)
         from public.registration_charges c
        where c.registration_id = r.id
          and c.status = 'paid'),
      0
    )
  from public.event_registrations r

  union all

  select
    lower(trim(r.registrant_email)),
    nullif(trim(r.registrant_name), ''),
    null::text,
    'event_attendee',
    r.created_at,
    0
  from public.event_registrations r
  where lower(trim(r.registrant_email)) is distinct from lower(trim(r.buyer_email))

  union all

  select
    lower(trim(b.client_email)),
    nullif(trim(b.client_name), ''),
    b.client_cognito_sub,
    'booking',
    b.created_at,
    case
      when b.status in ('confirmed', 'completed', 'no_show') then b.price_centavos
      else 0
    end
  from public.bookings b

  union all

  select
    lower(trim(coalesce(s.data->>'email', s.data->>'email_address'))),
    nullif(trim(coalesce(s.data->>'name', s.data->>'full_name', s.data->>'first_name')), ''),
    null::text,
    'enquiry',
    s.created_at,
    0
  from public.form_submissions s
  where not s.is_spam

  union all

  -- Group-class attendees. Money counts once the seat was real — confirmed or
  -- delivered (`completed`) — the same rule bookings use just above, and for
  -- the same reason: `pending_payment` never cleared, and a `cancelled` or
  -- `expired` seat was never occupied. There is no `no_show` in
  -- registration_status (0016), so bookings' third counted status has no
  -- counterpart here.
  select
    lower(trim(cr.client_email)),
    nullif(trim(cr.client_name), ''),
    cr.client_cognito_sub,
    'class_registration',
    cr.created_at,
    case
      when cr.status in ('confirmed', 'completed') then cr.price_centavos
      else 0
    end
  from public.class_registrations cr
)
select
  email,

  (array_agg(full_name order by seen_at desc) filter (where full_name is not null))[1]
    as full_name,

  (array_agg(cognito_sub order by seen_at desc) filter (where cognito_sub is not null))[1]
    as cognito_sub,

  array_agg(distinct source order by source)          as sources,

  count(*) filter (where source = 'course_order')       as course_orders,
  count(*) filter (where source = 'event_registration') as event_registrations,
  count(*) filter (where source = 'event_attendee')     as events_attending,
  count(*) filter (where source = 'booking')            as bookings,
  count(*) filter (where source = 'enquiry')            as enquiries,

  sum(paid_centavos)                                    as lifetime_centavos,

  min(seen_at)                                          as first_seen_at,
  max(seen_at)                                          as last_seen_at,

  -- Appended at the end, not alongside the other per-source counts above:
  -- `create or replace view` can only add columns after every existing one,
  -- not insert one in the middle, or Postgres refuses the replace outright
  -- (it reads as renaming `lifetime_centavos` to `classes`). Named access
  -- from both backend handlers means the column's position here doesn't
  -- otherwise matter.
  count(*) filter (where source = 'class_registration') as classes
from signals
where email is not null
  and email <> ''
  and email like '%@_%._%'
group by email;

comment on view public.people_directory is
  'Everyone who has ever transacted or enquired, keyed by lowercased email. '
  'Derived, never written to. Cognito remains the system of record for accounts; '
  'this view only reports the people Postgres happens to know about.';

-- `create or replace view` keeps the existing options and grants — this repeats
-- them anyway, exactly as 0022 set them, so this file stays a complete,
-- self-contained definition of the view rather than depending on a reader
-- having 0022 open beside it to know the access rules are still in force.
alter view public.people_directory set (security_invoker = on);

revoke all on public.people_directory from anon, authenticated;
grant select on public.people_directory to service_role;

notify pgrst, 'reload schema';

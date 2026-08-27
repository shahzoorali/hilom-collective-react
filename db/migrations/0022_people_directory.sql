-- Phase 8 — the People directory.
--
-- There is no `users` table in this schema, and this migration does not add
-- one. That absence is deliberate and is stated in three places already
-- (orders 0001:85, bookings 0012:62, event_registrations 0016:307): identity
-- lives in Cognito, and Postgres records a person only where they actually
-- transacted. A `users` table would be a fourth copy of an email address that
-- Cognito already owns, and it would go stale the first time someone changed
-- theirs.
--
-- What was genuinely missing is the *read*: "show me everyone who has ever
-- dealt with us" required four separate queries and a spreadsheet to merge
-- them. This view is that merge, done once, in the one place that can see all
-- four tables at the same instant.
--
-- A view rather than a table: there is no state here that isn't already
-- durable somewhere else. Nothing writes to it, nothing can drift from its
-- sources, and a person who cancels their only booking disappears from it for
-- the same reason they should.
--
-- Identity is the lowercased, trimmed email. That is the same key the rest of
-- the system already joins on — `orders.buyer_email`, `bookings.client_email`,
-- `event_registrations.buyer_email` are all matched case-insensitively by the
-- handlers — so this view does not invent a new notion of sameness, it applies
-- the existing one consistently.

-- ---------------------------------------------------------------------------
-- people_directory — one row per person, aggregated across every source
-- ---------------------------------------------------------------------------
create or replace view public.people_directory as
with signals as (
  -- Course buyers. Money counts when it was received: a refunded order is a
  -- real interaction with a real person, but it is not lifetime value, so the
  -- row survives and the amount does not.
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

  -- Event payers. Unlike an order, a registration's total is what was *agreed*,
  -- not what has arrived — an instalment plan is mostly unpaid on day one — so
  -- the money comes from the charge ledger, which is the only thing that knows
  -- what actually cleared. Waived and void charges are settled but are not
  -- money, exactly as charge_status (0016:87) defines them.
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

  -- Event attendees, where the attendee is not the payer. Booking a retreat
  -- for a partner is ordinary (0016:317), and the attendee is a person we hold
  -- a phone number for and will email — so they belong in a directory of
  -- people. They carry no money: the payer already carries all of it, and
  -- counting it twice would inflate every total on the screen.
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

  -- Facilitator-session clients. Counted as money once the session is real —
  -- confirmed, delivered, or missed by the client, which is still charged.
  -- Cancelled and refunded are not.
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

  -- Enquiries. Form fields are author-defined, so there is no typed email
  -- column to read — the handful of key spellings below are what the forms in
  -- this CMS actually use. Spam-flagged rows are excluded: they are kept for
  -- recoverability (0006:141), not for mailing.
  select
    lower(trim(coalesce(s.data->>'email', s.data->>'email_address'))),
    nullif(trim(coalesce(s.data->>'name', s.data->>'full_name', s.data->>'first_name')), ''),
    null::text,
    'enquiry',
    s.created_at,
    0
  from public.form_submissions s
  where not s.is_spam
)
select
  email,

  -- The most recently supplied name wins. Someone who books under "Ma. Cristina
  -- Santos" after enquiring as "cristina" has told us the longer one second,
  -- and the newer answer is the better one to address them by.
  (array_agg(full_name order by seen_at desc) filter (where full_name is not null))[1]
    as full_name,

  -- Present only if they have ever signed in. This is what distinguishes an
  -- account holder from someone who only ever filled in a form, and it is the
  -- join key to Cognito for anything the directory itself cannot answer.
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
  max(seen_at)                                          as last_seen_at
from signals
-- A blank or malformed address is not a person. Form submissions are the only
-- unvalidated source here, and an empty optional email field would otherwise
-- collapse every such enquiry into one nonsense row.
where email is not null
  and email <> ''
  and email like '%@_%._%'
group by email;

comment on view public.people_directory is
  'Everyone who has ever transacted or enquired, keyed by lowercased email. '
  'Derived, never written to. Cognito remains the system of record for accounts; '
  'this view only reports the people Postgres happens to know about.';

-- ---------------------------------------------------------------------------
-- Access — backend only.
--
-- Every column here is personal data, and the view's whole purpose is to put a
-- person's entire history with us on one row. That makes it strictly more
-- sensitive than any single table it reads, so it gets the same treatment as
-- orders and the audit log: the publishable key must never see it.
--
-- security_invoker is the important line. A view created by the table owner
-- normally runs with the *owner's* rights, which would let it read straight
-- past the RLS on orders, bookings and event_registrations for whoever managed
-- to select from it. With security_invoker the caller's own policies apply, so
-- the revoke below is a real boundary and not a suggestion.
-- ---------------------------------------------------------------------------
alter view public.people_directory set (security_invoker = on);

revoke all on public.people_directory from anon, authenticated;
grant select on public.people_directory to service_role;

-- PostgREST answers from a cached schema, and this is the first view in the
-- database — nothing here has needed the cache to notice a non-table before.
-- Supabase's event trigger usually reloads on DDL by itself; asking explicitly
-- costs nothing and turns "the endpoint 404s for a few minutes after deploy"
-- into a non-event.
notify pgrst, 'reload schema';
